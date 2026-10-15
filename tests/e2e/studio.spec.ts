import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodeRte } from '../../src/core/rte';

type Point = [number, number, number | null];
const complete: Point[] = [[0, 0, 100], [0, 0.0002, 110], [0.0001, 0.0004, 105], [0, 0.0006, 125]];
function gpx(points: Point[], waypoint = '') {
  return `<gpx version="1.1" creator="route-studio-test" xmlns="http://www.topografix.com/GPX/1/1">${waypoint}<trk><name>Forest trail</name><trkseg>${points.map(([lat, lon, h]) => `<trkpt lat="${lat}" lon="${lon}">${h === null ? '' : `<ele>${h}</ele>`}</trkpt>`).join('')}</trkseg></trk></gpx>`;
}
async function importText(page: Page, content: string, name = 'forest.gpx') {
  await page.getByLabel('Choose route file', { exact: true }).setInputFiles({ name, mimeType: 'application/xml', buffer: Buffer.from(content) });
  await expect(page.getByLabel('Route name', { exact: true })).toBeVisible();
}
async function step(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Route preparation steps' }).getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.locator('.panel-heading h2')).toHaveText(name);
}
async function confirmRoute(page: Page) {
  await page.getByRole('checkbox', { name: 'I have checked the route and direction on the map.' }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.panel-heading h2')).toHaveText('Stations');
}
async function downloadRoute(page: Page) {
  await step(page, 'Route');
  await page.getByRole('checkbox', { name: 'I have checked the route and direction on the map.' }).check();
  await step(page, 'Export');
  const downloadButton = page.getByRole('button', { name: 'Download .rte', exact: true });
  await expect(downloadButton).toBeEnabled({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.rte$/);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const bytes = new Uint8Array(await readFile(downloadedPath!));
  return { bytes, route: decodeRte(bytes) };
}
async function noOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test.beforeEach(async ({ page }) => {
  // Route editing and binary export must work when the external basemap is unavailable.
  await page.route('https://tiles.openfreemap.org/**', route => route.abort());
  await page.goto('/');
});

test('landing is usable on both screen sizes and rejects invalid input without losing the editor', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'A better route starts here.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a file', exact: true })).toBeVisible();
  await noOverflow(page);
  await page.getByLabel('Choose route file', { exact: true }).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a route') });
  await expect(page.getByRole('alert')).toContainText('Choose a GPX or KML route file.');
  await page.getByLabel('Choose route file', { exact: true }).setInputFiles({ name: 'broken.gpx', mimeType: 'application/xml', buffer: Buffer.from('<gpx><trk></gpx>') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Route name', { exact: true })).toHaveCount(0);
  await importText(page, gpx(complete));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await noOverflow(page);
  await page.getByRole('button', { name: '切换中文', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '路线处理步骤' })).toBeVisible();
});

test('cannot bypass route confirmation or change steps during a pending export', async ({ page }) => {
  // Delay delivery only: the real worker still encodes and validates the output.
  // This makes the export-in-progress state observable on fast machines.
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      const args = options === undefined ? [message] : [message, options];
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'export') {
        setTimeout(() => Reflect.apply(original, this, args), 1500);
      } else Reflect.apply(original, this, args);
    };
  });
  await page.reload();
  await importText(page, gpx(complete));
  await step(page, 'Export');
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Confirm route and direction first', exact: true }).click();
  await confirmRoute(page);
  await step(page, 'Review');
  await expect(page.locator('.stage-row')).toHaveCount(1);
  await step(page, 'Export');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .rte', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: 'Route preparation steps' });
  for (const button of await navigation.getByRole('button').all()) await expect(button).toBeDisabled();
  await expect(page.locator('.panel-body')).toHaveAttribute('disabled', '');
  await expect(page.getByRole('button', { name: 'Download processing report', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const file = await download;
  expect(decodeRte(new Uint8Array(await readFile((await file.path())!))).name).toBe('Forest trail');
  await expect(navigation.getByRole('button', { name: /Route/ })).toBeEnabled();
});

test('edits stations, undoes deletion, exports valid bytes, and restores a draft with stable revisions', async ({ page, isMobile }) => {
  await importText(page, gpx(complete));
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await confirmRoute(page);
  if (isMobile) await page.getByRole('button', { name: 'Profile', exact: true }).click();
  const progress = page.getByRole('slider', { name: 'Route progress', exact: true });
  await progress.fill('30');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Spring water');
  await page.getByLabel('Short label', { exact: true }).fill('WATER');
  await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption('3');
  await expect(page.getByLabel('Along-route distance (m)', { exact: true })).toHaveValue('30');
  await expect(page.locator('.station-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Delete station', exact: true }).click();
  await expect(page.locator('.station-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.station-row')).toHaveCount(3);
  await expect(page.locator('.station-row', { hasText: 'Spring water' })).toBeVisible();
  await noOverflow(page);
  const first = await downloadRoute(page);
  expect(first.route.name).toBe('Forest trail');
  expect(first.route.revision).toBe(1);
  expect(first.route.elev?.length).toBeGreaterThan(2);
  expect(first.route.stations.find(station => station.name === 'Spring water')).toMatchObject({ kind: 3, sDm: 300 });
  const repeated = await downloadRoute(page);
  expect(repeated.bytes).toEqual(first.bytes);
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Pick up where you left off/ }).click();
  await expect(page.getByLabel('Route name', { exact: true })).toHaveValue('Forest trail');
  const restored = await downloadRoute(page);
  expect(restored.bytes).toEqual(first.bytes);
  await step(page, 'Route');
  await page.getByLabel('Route name', { exact: true }).fill('Forest trail updated');
  const changed = await downloadRoute(page);
  expect(changed.route.routeId).toEqual(first.route.routeId);
  expect(changed.route.revision).toBe(2);
  expect(changed.route.name).toBe('Forest trail updated');
});

test('requires a deliberate visit choice at repeated crossings', async ({ page }) => {
  const crossing: Point[] = [[0, 0, 100], [0, 0.001, 110], [0.001, 0.001, 120], [0, 0.001, 110], [0, 0.002, 100]];
  await importText(page, gpx(crossing, '<wpt lat="0" lon="0.001"><name>Crossing CP</name></wpt>'));
  await confirmRoute(page);
  await expect(page.getByText('1 station positions need your confirmation.', { exact: true })).toBeVisible();
  await step(page, 'Export');
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeDisabled();
  await expect(page.locator('.issue strong', { hasText: 'STATION_UNCONFIRMED' })).toBeVisible();
  await step(page, 'Stations');
  await page.locator('.station-row', { hasText: 'Crossing CP' }).click();
  await expect(page.locator('.candidate')).toHaveCount(2);
  await page.locator('.candidate').last().click();
  const selectedDistance = Number(await page.getByLabel('Along-route distance (m)', { exact: true }).inputValue());
  expect(selectedDistance).toBeGreaterThan(300);
  const exported = await downloadRoute(page);
  expect(exported.route.stations.find(station => station.name === 'Crossing CP')!.sDm).toBe(Math.round(selectedDistance * 10));
});

test('interpolates only an explicitly selected short interior elevation gap', async ({ page }) => {
  await importText(page, gpx([[0, 0, 100], [0, 0.0001, null], [0, 0.0002, 120]]));
  await confirmRoute(page);
  await step(page, 'Elevation');
  await expect(page.getByRole('radio', { name: /Route geometry only/ })).toBeChecked();
  await page.getByRole('radio', { name: /Use source elevation/ }).check();
  await expect(page.locator('.issue strong', { hasText: 'INCOMPLETE_ELEVATION' })).toBeVisible();
  await step(page, 'Export');
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeDisabled();
  await step(page, 'Elevation');
  await page.getByRole('radio', { name: /Fill short interior gaps/ }).check();
  const exported = await downloadRoute(page);
  expect(exported.route.elevationInfo?.containsFilledValues).toBe(true);
  expect(exported.route.elev!.at(-1)!.upDm).toBe(200);
});

test('rejects unknown endpoint elevation and supports a geometry-only export', async ({ page }) => {
  await importText(page, gpx([[0, 0, null], [0, 0.0001, 110], [0, 0.0002, 120]]));
  await confirmRoute(page);
  await step(page, 'Elevation');
  await page.getByRole('radio', { name: /Fill short interior gaps/ }).check();
  await expect(page.locator('.issue strong', { hasText: 'INCOMPLETE_ELEVATION' })).toBeVisible();
  await page.getByRole('radio', { name: /Route geometry only/ }).check();
  const exported = await downloadRoute(page);
  expect(exported.route.elev).toBeUndefined();
  expect(exported.route.elevationInfo).toBeUndefined();
});

test('keeps KML altitude uncertainty explicit and records accepted provenance', async ({ page }) => {
  await importText(page, '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>KML hill</name><LineString><coordinates>0,0,100 0.0001,0,110 0.0002,0,120</coordinates></LineString></Placemark></kml>', 'hill.kml');
  await confirmRoute(page);
  await step(page, 'Elevation');
  await page.getByRole('radio', { name: /Use source elevation/ }).check();
  const acceptance = page.getByRole('checkbox', { name: /I accept the source/ });
  await expect(acceptance).not.toBeChecked();
  await step(page, 'Export');
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeDisabled();
  await step(page, 'Elevation');
  await acceptance.check();
  const exported = await downloadRoute(page);
  expect(exported.route.elevationInfo).toMatchObject({ verticalDatum: 0, quality: 1 });
  expect(exported.route.elev!.at(-1)!.upDm).toBe(200);
});

for (const extension of ['gpx', 'kml']) {
  test(`imports and exports real EMY20K.${extension} with explicitly confirmed stations`, async ({ page, isMobile }) => {
    await page.getByLabel('Choose route file', { exact: true }).setInputFiles(fileURLToPath(new URL(`../fixtures/routes/2026MY/EMY20K.${extension}`, import.meta.url)));
    await expect(page.getByLabel('Route name', { exact: true })).toBeVisible();
    await expect(page.locator('.source-file')).toContainText('1,898');
    await confirmRoute(page);
    const rows = page.locator('.station-row');
    expect(await rows.count()).toBeGreaterThan(2);
    for (let index = 0; index < await rows.count(); index++) {
      await rows.nth(index).click();
      const confirm = page.getByRole('button', { name: 'Confirm this visit', exact: true });
      if (await confirm.count()) await confirm.click();
    }
    await step(page, 'Elevation');
    await page.getByRole('radio', { name: /Route geometry only/ }).check();
    if (isMobile) {
      await page.getByRole('button', { name: 'Profile', exact: true }).click();
      await expect(page.getByRole('slider', { name: 'Route progress', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Map', exact: true }).click();
      const mapBounds = await page.locator('.route-map').boundingBox();
      const panelBounds = await page.locator('.map-panel').boundingBox();
      expect(mapBounds!.height).toBeLessThanOrEqual(panelBounds!.height);
    }
    const drawingBounds = await page.locator('.maplibregl-canvas, .route-map__sketch').first().boundingBox();
    expect(drawingBounds!.height).toBeGreaterThan(200);
    expect(drawingBounds!.width).toBeGreaterThan(200);
    await noOverflow(page);
    const exported = await downloadRoute(page);
    expect(exported.route.totalSDm).toBeGreaterThan(150_000);
    expect(exported.route.totalSDm).toBeLessThan(300_000);
    expect(exported.route.stations.length).toBeGreaterThan(2);
    expect(exported.route.elev).toBeUndefined();
  });
}

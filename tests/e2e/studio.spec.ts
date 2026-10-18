import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodeRte } from '../../src/core/rte';

type Point = [number, number, number | null];
const complete: Point[] = [
  [0, 0, 100],
  [0, 0.0002, 110],
  [0.0001, 0.0004, 105],
  [0, 0.0006, 125],
];
function gpx(points: Point[], waypoint = '') {
  return `<gpx version="1.1" creator="route-studio-test" xmlns="http://www.topografix.com/GPX/1/1">${waypoint}<trk><name>Forest trail</name><trkseg>${points.map(([lat, lon, h]) => `<trkpt lat="${lat}" lon="${lon}">${h === null ? '' : `<ele>${h}</ele>`}</trkpt>`).join('')}</trkseg></trk></gpx>`;
}
async function importText(page: Page, content: string, name = 'forest.gpx') {
  await page
    .getByLabel('Choose route file', { exact: true })
    .setInputFiles({ name, mimeType: 'application/xml', buffer: Buffer.from(content) });
  await expect(page.getByLabel('Route name', { exact: true })).toBeVisible();
}
const stepNames = ['Import', 'Route', 'Stations', 'Elevation', 'Review', 'Export'];
async function step(page: Page, name: string) {
  const current = await page.locator('.panel-heading h2').textContent();
  const from = stepNames.indexOf(current!);
  const to = stepNames.indexOf(name);
  if (to > from) {
    for (let index = from + 1; index <= to; index++) {
      await page
        .getByRole('navigation')
        .getByRole('button', { name: new RegExp(stepNames[index]) })
        .click();
      await expect(page.locator('.panel-heading h2')).toHaveText(stepNames[index]);
    }
  } else {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: new RegExp(name) })
      .click();
  }
  await expect(page.locator('.panel-heading h2')).toHaveText(name);
}
async function confirmRoute(page: Page) {
  await page
    .getByRole('checkbox', { name: 'I have checked the route and direction on the map.' })
    .check();
  await page.getByRole('button', { name: 'Next: Stations', exact: true }).click();
  await expect(page.locator('.panel-heading h2')).toHaveText('Stations');
}
async function downloadRoute(page: Page) {
  await step(page, 'Route');
  await page
    .getByRole('checkbox', { name: 'I have checked the route and direction on the map.' })
    .check();
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
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test.beforeEach(async ({ page }) => {
  // Route editing and binary export must work when the external basemap is unavailable.
  await page.route('https://tiles.openfreemap.org/**', (route) => route.abort());
  await page.route('https://geomag.bgs.ac.uk/web_service/**', (route) => route.abort());
  await page.goto('/');
});

test('landing is usable on both screen sizes and rejects invalid input without losing the editor', async ({
  page,
}) => {
  await expect(page.getByRole('heading', { name: 'Import route file' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a file', exact: true })).toBeVisible();
  await noOverflow(page);
  await page.getByLabel('Choose route file', { exact: true }).setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a route'),
  });
  await expect(page.getByRole('alert')).toContainText('Choose a GPX or KML route file.');
  await page.getByLabel('Choose route file', { exact: true }).setInputFiles({
    name: 'broken.gpx',
    mimeType: 'application/xml',
    buffer: Buffer.from('<gpx><trk></gpx>'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Route name', { exact: true })).toHaveCount(0);
  await importText(page, gpx(complete));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await noOverflow(page);
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh');
  await expect(page.getByRole('navigation', { name: '路线处理步骤' })).toBeVisible();
});

test('cannot bypass route confirmation or change steps during a pending export', async ({
  page,
}) => {
  // Delay delivery only: the real worker still encodes and validates the output.
  // This makes the export-in-progress state observable on fast machines.
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      const args = options === undefined ? [message] : [message, options];
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'export'
      ) {
        setTimeout(() => Reflect.apply(original, this, args), 1500);
      } else Reflect.apply(original, this, args);
    };
  });
  await page.reload();
  await importText(page, gpx(complete));
  for (const name of ['Stations', 'Elevation', 'Review', 'Export']) {
    await expect(
      page.getByRole('navigation').getByRole('button', { name: new RegExp(name) }),
    ).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeDisabled();
  await confirmRoute(page);
  await expect(page.getByRole('navigation').getByRole('button', { name: /Review/ })).toBeDisabled();
  await expect(page.getByRole('navigation').getByRole('button', { name: /Export/ })).toBeDisabled();
  await step(page, 'Review');
  await expect(page.locator('.stage-row')).toHaveCount(1);
  await step(page, 'Export');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .rte', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: 'Route preparation steps' });
  for (const button of await navigation.getByRole('button').all())
    await expect(button).toBeDisabled();
  await expect(page.locator('.panel-fields')).toHaveAttribute('disabled', '');
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send to device', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Download processing report', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const file = await download;
  expect(decodeRte(new Uint8Array(await readFile((await file.path())!))).name).toBe('Forest trail');
  await expect(navigation.getByRole('button', { name: /Route/ })).toBeEnabled();
});

test('keeps the next action visible and follows each editing step with the relevant preview', async ({
  page,
}) => {
  for (const viewport of [
    { width: 1024, height: 600 },
    { width: 390, height: 667 },
  ]) {
    await page.setViewportSize(viewport);
    await importText(page, gpx(complete));
    const confirmation = page.getByRole('checkbox', {
      name: 'I have checked the route and direction on the map.',
    });
    const next = page.getByRole('button', { name: 'Next: Stations', exact: true });
    const reason = page.locator('#step-progress-help');
    await expect(reason).toHaveText('Confirm the route and direction to continue.');
    await expect(reason).toBeInViewport({ ratio: 1 });
    await expect(confirmation).toBeInViewport({ ratio: 1 });
    await expect(next).toBeInViewport({ ratio: 1 });
    await expect(next).toBeDisabled();
    await expect(next).toHaveAttribute('aria-describedby', 'step-progress-help');
    await expect(page.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    const progress = page.getByRole('slider', { name: 'Route progress', exact: true });
    await progress.fill('30');
    await page.getByLabel('Route name', { exact: true }).fill('Forest trail updated');
    await expect(page.locator('.visual-workspace')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: 'Profile', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await confirmation.check();
    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.locator('.panel-heading h2')).toHaveText('Stations');
    await expect(page.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(progress).toHaveValue('30');
    await page.getByRole('button', { name: 'Next: Elevation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Profile', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.profile-panel')).toBeVisible();
    await expect(progress).toHaveValue('30');
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await page.getByRole('radio', { name: /Fill gaps and export/ }).check();
    await expect(page.locator('.visual-workspace')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('.panel-heading h2')).toHaveText('Route');
    await expect(page.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(progress).toHaveValue('30');
    await noOverflow(page);
  }
});

test('edits the simplification slider with the keyboard, invalidates confirmation, and preserves drafts and undo', async ({
  page,
}) => {
  await importText(page, gpx(complete));
  await expect(
    page.getByRole('heading', { name: 'Route simplification', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Magnetic declination', exact: true }),
  ).toBeVisible();
  const reverse = page.getByRole('button', { name: 'Reverse route', exact: true });
  await expect(reverse).toBeVisible();
  await expect(reverse).toHaveText('Reverse route');
  await expect(page.locator('.direction-card small')).toHaveText(/^\d+\.\d{2} km$/);
  await expect(page.locator('.direction-card')).not.toContainText('open route');
  await expect(page.locator('.direction-card')).not.toContainText('closed loop');
  await expect(
    page.getByText('Larger values retain fewer route points. Distances stay unchanged.', {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      'Automatically query BGS WMM2025 using the route midpoint and selected UTC date. Only that coordinate and date are sent. Assumed WGS84 ellipsoid height: 0 m. If unavailable, the metadata is omitted. You can also enter a manual reference.',
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Declination source', exact: true })).toHaveValue(
    'auto',
  );
  const tolerance = page.getByRole('slider', {
    name: 'Simplification tolerance (m)',
    exact: true,
  });
  await expect(tolerance).toHaveAttribute('min', '1');
  await expect(tolerance).toHaveAttribute('max', '5');
  await expect(tolerance).toHaveAttribute('step', '0.5');
  await expect(tolerance).toHaveValue('2');
  const confirmation = page.getByRole('checkbox', {
    name: 'I have checked the route and direction on the map.',
  });
  await confirmation.check();
  await expect(page.getByRole('button', { name: 'Next: Stations', exact: true })).toBeEnabled();
  await tolerance.press('ArrowRight');
  await expect(tolerance).toHaveValue('2.5');
  await expect(confirmation).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Next: Stations', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tolerance).toHaveValue('2');
  await expect(confirmation).not.toBeChecked();
  await tolerance.press('End');
  await expect(tolerance).toHaveValue('5');
  await tolerance.press('Home');
  await expect(tolerance).toHaveValue('1');
  await tolerance.press('ArrowRight');
  await expect(tolerance).toHaveValue('1.5');
  await expect(
    page.getByRole('status', { name: 'Saved on this device', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Continue editing/ }).click();
  await expect(tolerance).toHaveValue('1.5');
  await confirmation.check();
  await expect(page.getByRole('button', { name: 'Next: Stations', exact: true })).toBeEnabled();
  await tolerance.press('ArrowRight');
  await expect(tolerance).toHaveValue('2');
  await expect(confirmation).not.toBeChecked();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tolerance).toHaveValue('1.5');
  const output = await downloadRoute(page);
  expect(output.route.name).toBe('Forest trail');
});

test('preserves a saved tolerance outside the slider range until an explicit reset', async ({
  page,
}) => {
  await importText(page, gpx(complete));
  await expect(page.locator('.visual-workspace')).toHaveAttribute('aria-busy', 'false');
  await expect(
    page.getByRole('status', { name: 'Saved on this device', exact: true }),
  ).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('trl-x-route-studio');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('drafts', 'readwrite');
          const store = tx.objectStore('drafts');
          const current = store.get('current');
          current.onsuccess = () => {
            const draft = current.result;
            draft.editor.options.geometryToleranceM = 20;
            store.put(draft, 'current');
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
  await page.reload();
  await page.getByRole('button', { name: /Continue editing/ }).click();
  const tolerance = page.getByRole('slider', {
    name: 'Simplification tolerance (m)',
    exact: true,
  });
  await expect(tolerance).toHaveCount(0);
  await expect(
    page.getByText(
      'The saved tolerance is 20 m. The slider supports 1–5 m in 0.5 m steps. Restore the 2 m default to adjust it.',
      { exact: true },
    ),
  ).toBeVisible();
  const reset = page.getByRole('button', { name: 'Use default tolerance', exact: true });
  await expect(reset).toBeVisible();
  await confirmRoute(page);
  await step(page, 'Review');
  const reportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download processing report', exact: true }).click();
  const report = JSON.parse(await readFile((await (await reportDownload).path())!, 'utf8'));
  expect(report.parameters.geometryToleranceM).toBe(20);
  await step(page, 'Route');
  await expect(tolerance).toHaveCount(0);
  await reset.click();
  await expect(tolerance).toBeEnabled();
  await expect(tolerance).toHaveValue('2');
  const confirmation = page.getByRole('checkbox', {
    name: 'I have checked the route and direction on the map.',
  });
  await expect(confirmation).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Next: Stations', exact: true })).toBeDisabled();
  await confirmation.check();
  await expect(page.getByRole('button', { name: 'Next: Stations', exact: true })).toBeEnabled();
  await tolerance.press('ArrowRight');
  await expect(tolerance).toHaveValue('2.5');
  await expect(confirmation).not.toBeChecked();
});

test('edits stations, undoes deletion, exports valid bytes, and restores a draft with stable revisions', async ({
  page,
}) => {
  await importText(page, gpx(complete));
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeDisabled();
  await confirmRoute(page);
  if (await page.getByRole('button', { name: 'Profile', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
  const progress = page.getByRole('slider', { name: 'Route progress', exact: true });
  await progress.fill('30');
  await page.getByRole('button', { name: 'Add station', exact: true }).click();
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
  expect(first.route.stations.find((station) => station.name === 'Spring water')).toMatchObject({
    kind: 3,
    sDm: 300,
  });
  const repeated = await downloadRoute(page);
  expect(repeated.bytes).toEqual(first.bytes);
  await expect(
    page.getByRole('status', { name: 'Saved on this device', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Continue editing/ }).click();
  await expect(page.getByLabel('Route name', { exact: true })).toHaveValue('Forest trail');
  const restored = await downloadRoute(page);
  expect(restored.bytes).toEqual(first.bytes);
  await step(page, 'Route');
  await page.getByLabel('Route name', { exact: true }).fill('Forest trail updated');
  await expect(page.getByRole('navigation').getByRole('button', { name: /Export/ })).toBeDisabled();
  const changed = await downloadRoute(page);
  expect(changed.route.routeId).toEqual(first.route.routeId);
  expect(changed.route.revision).toBe(2);
  expect(changed.route.name).toBe('Forest trail updated');
});

test('requires a deliberate visit choice at repeated crossings', async ({ page }) => {
  const crossing: Point[] = [
    [0, 0, 100],
    [0, 0.001, 110],
    [0.001, 0.001, 120],
    [0, 0.001, 110],
    [0, 0.002, 100],
  ];
  await importText(page, gpx(crossing, '<wpt lat="0" lon="0.001"><name>Crossing CP</name></wpt>'));
  await confirmRoute(page);
  await expect(
    page.getByText('1 station position needs your confirmation.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation').getByRole('button', { name: /Elevation/ }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeDisabled();
  await expect(page.locator('#step-progress-help')).toHaveText(
    'Confirm station positions and resolve station issues to continue.',
  );
  await expect(page.locator('#step-progress-help')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('navigation').getByRole('button', { name: /Export/ })).toBeDisabled();
  await expect(page.locator('.issue[data-code="STATION_UNCONFIRMED"]')).toHaveCount(0);
  await step(page, 'Stations');
  await page.locator('.station-row', { hasText: 'Crossing CP' }).click();
  await expect(page.locator('.candidate')).toHaveCount(2);
  await page.locator('.candidate').last().click();
  const selectedDistance = Number(
    await page.getByLabel('Along-route distance (m)', { exact: true }).inputValue(),
  );
  expect(selectedDistance).toBeGreaterThan(300);
  const exported = await downloadRoute(page);
  expect(exported.route.stations.find((station) => station.name === 'Crossing CP')!.sDm).toBe(
    Math.round(selectedDistance * 10),
  );
});

for (const font of ['default', 'wide'] as const) {
  test(`edits stations beside the selected row and cycles through remaining confirmations (${font} font)`, async ({
    page,
    isMobile,
  }) => {
    const crossing: Point[] = [
      [0, 0, 100],
      [0, 0.001, 110],
      [0.001, 0.001, 120],
      [0, 0.001, 110],
      [0, 0.002, 100],
    ];
    const landmarks = Array.from({ length: 12 }, (_, index) => {
      const name = `Crossing ${String(index + 1).padStart(2, '0')}`;
      return `<wpt lat="0" lon="0.001"><name>${name}</name></wpt>`;
    }).join('');
    if (font === 'wide') {
      await page.addStyleTag({ content: ':root { font-family: Verdana, sans-serif; }' });
    }
    await importText(page, gpx(crossing, landmarks));
    await confirmRoute(page);
    await expect(
      page.getByText(
        'To add: choose a position on the map or profile, then select Add station. To move: select a station, choose a new position, then select Move to cursor.',
        { exact: true },
      ),
    ).toHaveCount(0);
    const rows = page.locator('.station-row');
    await expect(rows).toHaveCount(14);
    await expect(rows.filter({ hasText: 'Position needs confirmation' })).toHaveCount(12);
    const pending = page.getByRole('list', { name: 'Unconfirmed stations', exact: true });
    const last = rows.filter({ hasText: 'Crossing 12' });
    const pendingLast = pending.getByRole('button', { name: /Crossing 12/ });
    await expect(pendingLast).toContainText(/\d+\.\d{2} km/);
    await pendingLast.click();
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport({ ratio: 1 });
    await expect(last).toHaveAttribute('aria-expanded', 'true');
    await expect(last).toContainText('Collapse editor');
    const name = page.getByLabel('Name', { exact: true });
    const next = page.getByRole('button', { name: 'Next unconfirmed station', exact: true });
    await expect(name).toHaveValue('Crossing 12');
    const selectedDistance = Number(
      await page.getByLabel('Along-route distance (m)', { exact: true }).inputValue(),
    );
    await expect
      .poll(async () =>
        Number(
          await page.getByRole('slider', { name: 'Route progress', exact: true }).inputValue(),
        ),
      )
      .toBeCloseTo(selectedDistance, 0);
    if (isMobile) await page.getByRole('button', { name: 'Collapse preview', exact: true }).click();
    await expect(name).toBeInViewport({ ratio: 1 });
    await last.click();
    await expect(last).toHaveAttribute('aria-expanded', 'false');
    await expect(last).toContainText('Expand to edit');
    await expect(name).toHaveCount(0);
    await last.press('Enter');
    await expect(last).toHaveAttribute('aria-expanded', 'true');
    await expect(name).toHaveValue('Crossing 12');
    await last.press('Space');
    await expect(last).toHaveAttribute('aria-expanded', 'false');
    await expect(name).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await last.press('Enter');
    await expect(name).toHaveValue('Crossing 12');
    await expect(name).toBeVisible();
    expect(
      await page.locator('.station-editor-reveal').evaluate((el) => {
        const style = getComputedStyle(el);
        return (
          style.animationName === 'none' ||
          style.animationDuration.split(',').every((duration) => {
            const value = Number.parseFloat(duration);
            return (duration.trim().endsWith('ms') ? value / 1000 : value) <= 0.001;
          })
        );
      }),
    ).toBe(true);
    await pending.getByRole('button', { name: /Crossing 01/ }).click();
    const first = rows.filter({ hasText: 'Crossing 01' });
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    await expect(last).toHaveAttribute('aria-expanded', 'false');
    await expect(name).toHaveValue('Crossing 01');
    await expect(page.locator('.station-editor')).toHaveCount(1);
    const editorId = await first.getAttribute('aria-controls');
    expect(editorId).not.toBeNull();
    await expect(
      page.locator('.station-item').filter({ has: first }).locator('.station-editor'),
    ).toHaveAttribute('id', editorId!);
    await next.click();
    await expect(name).toHaveValue('Crossing 02');
    await page.getByRole('button', { name: 'Confirm station position', exact: true }).click();
    await expect(rows.filter({ hasText: 'Crossing 02' })).not.toContainText(
      'Position needs confirmation',
    );
    await expect(rows.filter({ hasText: 'Position needs confirmation' })).toHaveCount(11);
    await expect(pending.getByRole('button', { name: /Crossing 02/ })).toHaveCount(0);
    await next.click();
    await expect(name).toHaveValue('Crossing 03');
    await rows.filter({ hasText: 'Crossing 12' }).click();
    await next.click();
    await expect(name).toHaveValue('Crossing 01');
    await next.click();
    await expect(name).toHaveValue('Crossing 03');
    await expect(rows).toHaveCount(14);
    await expect(page.getByRole('button', { name: 'Next: Elevation', exact: true })).toBeDisabled();
    await noOverflow(page);
  });
}

test('keeps advanced elevation settings visible and preserves their values', async ({ page }) => {
  await importText(page, gpx(complete));
  await confirmRoute(page);
  await step(page, 'Elevation');
  await expect(page.getByText('Source elevation is complete', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Use source elevation/ })).toBeChecked();
  const advanced = page.getByRole('region', {
    name: 'Advanced elevation settings',
    exact: true,
  });
  await expect(advanced).toBeVisible();
  const interval = page.getByLabel('Sampling interval (m)', { exact: true });
  const smoothing = page.getByLabel('Smoothing window (m)', { exact: true });
  const comparison = page.getByRole('checkbox', {
    name: 'Compare original elevation',
    exact: true,
  });
  await expect(interval).toBeVisible();
  await expect(smoothing).toBeVisible();
  await expect(advanced.locator('summary')).toHaveCount(0);
  await expect(interval).toHaveValue('10');
  await expect(smoothing).toHaveValue('0');
  await expect(comparison).toBeChecked();
  // Delay the next real processing task so the pending summary remains observable.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    let delayed = false;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      const args = options === undefined ? [message] : [message, options];
      if (
        !delayed &&
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'process'
      ) {
        delayed = true;
        setTimeout(() => Reflect.apply(original, this, args), 1500);
      } else Reflect.apply(original, this, args);
    };
  });
  await interval.selectOption('20');
  await expect(page.getByText('Checking elevation…', { exact: true })).toBeVisible();
  await expect(page.getByText('Source elevation is complete', { exact: true })).toBeHidden();
  await expect(page.locator('.visual-workspace')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByText('Source elevation is complete', { exact: true })).toBeVisible();
  await smoothing.selectOption('30');
  await comparison.uncheck();
  await expect(page.locator('.visual-workspace')).toHaveAttribute('aria-busy', 'false');
  await expect(interval).toBeVisible();
  await step(page, 'Review');
  await step(page, 'Elevation');
  await expect(interval).toBeVisible();
  await expect(interval).toHaveValue('20');
  await expect(smoothing).toHaveValue('30');
  await expect(comparison).not.toBeChecked();
  await step(page, 'Export');
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send to device', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  const details = page.getByRole('region', { name: 'File details', exact: true });
  await expect(details).toBeVisible();
  await expect(details.locator('summary')).toHaveCount(0);
  await expect(page.getByText('TRL-X Route 1.0', { exact: true })).toBeVisible();
  await expect(page.getByText('Revision', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download processing report', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The RTE file is validated before download. Unchanged content keeps its revision; changed content increments it.',
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeEnabled();
});

test('repairs an invalid restored value in the visible advanced elevation settings', async ({
  page,
}) => {
  await importText(page, gpx(complete));
  await expect(page.locator('.visual-workspace')).toHaveAttribute('aria-busy', 'false');
  await expect(
    page.getByRole('status', { name: 'Saved on this device', exact: true }),
  ).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('trl-x-route-studio');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('drafts', 'readwrite');
          const store = tx.objectStore('drafts');
          const current = store.get('current');
          current.onsuccess = () => {
            const draft = current.result;
            draft.editor.options.elevationIntervalM = 0;
            store.put(draft, 'current');
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
  await page.reload();
  await page.getByRole('button', { name: /Continue editing/ }).click();
  await confirmRoute(page);
  await step(page, 'Elevation');
  const advanced = page.getByRole('region', {
    name: 'Advanced elevation settings',
    exact: true,
  });
  const interval = page.getByLabel('Sampling interval (m)', { exact: true });
  await expect(page.locator('.issue[data-code="OPTIONS_INVALID"]')).toBeVisible();
  await expect(advanced).toBeVisible();
  await expect(interval).toBeVisible();
  await expect(interval).toHaveValue('0');
  await expect(page.getByRole('button', { name: 'Next: Review', exact: true })).toBeDisabled();
  await interval.selectOption('20');
  await expect(page.getByText('Source elevation is complete', { exact: true })).toBeVisible();
  await expect(page.locator('.issue[data-code="OPTIONS_INVALID"]')).toHaveCount(0);
  await expect(interval).toBeVisible();
  await expect(interval).toHaveValue('20');
  await expect(page.getByRole('button', { name: 'Next: Review', exact: true })).toBeEnabled();
});

test('fills imported interior gaps by default and preserves an explicit source-only choice', async ({
  page,
}) => {
  await importText(
    page,
    gpx([
      [0, 0, 100],
      [0, 0.0001, null],
      [0, 0.0002, 120],
    ]),
  );
  await confirmRoute(page);
  await step(page, 'Elevation');
  await expect(page.getByRole('radio', { name: /Fill gaps and export/ })).toBeChecked();
  await expect(page.getByText('Interior elevation gaps filled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next: Review', exact: true })).toBeEnabled();
  await expect(page.getByRole('radio', { name: /Omit elevation/ })).toHaveCount(0);
  await page.getByRole('radio', { name: /Use source elevation/ }).check();
  await expect(page.locator('.issue[data-code="INCOMPLETE_ELEVATION"]')).toBeVisible();
  await expect(page.getByText('Elevation needs attention', { exact: true })).toBeVisible();
  await expect(page.getByText('Advanced elevation settings', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button', { name: /Review/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeDisabled();
  await expect(page.locator('#step-progress-help')).toHaveText(
    'Resolve the elevation issues before continuing.',
  );
  await expect(page.locator('#step-progress-help')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('navigation').getByRole('button', { name: /Export/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('radio', { name: /Fill gaps and export/ })).toBeChecked();
  await expect(page.getByText('Interior elevation gaps filled', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /Use source elevation/ }).check();
  await expect(
    page.getByRole('status', { name: 'Saved on this device', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Continue editing/ }).click();
  await confirmRoute(page);
  await step(page, 'Elevation');
  await expect(page.getByRole('radio', { name: /Use source elevation/ })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Next: Review', exact: true })).toBeDisabled();
  await page.getByRole('radio', { name: /Fill gaps and export/ }).check();
  await expect(page.getByText('Interior elevation gaps filled', { exact: true })).toBeVisible();
  const exported = await downloadRoute(page);
  expect(exported.route.elevationInfo?.containsFilledValues).toBe(true);
  expect(exported.route.elev!.at(-1)!.upDm).toBe(200);
});

test('restores an old elevation-omitting draft with source elevation required', async ({
  page,
}) => {
  await importText(
    page,
    gpx([
      [0, 0, 100],
      [0, 0.0001, null],
      [0, 0.0002, 120],
    ]),
  );
  await expect(
    page.getByRole('status', { name: 'Saved on this device', exact: true }),
  ).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('trl-x-route-studio');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('drafts', 'readwrite');
          const store = tx.objectStore('drafts');
          const current = store.get('current');
          current.onsuccess = () => {
            const draft = current.result;
            draft.version = 2;
            draft.editor.options.elevationMode = 'omit';
            draft.editor.declinationMode = 'manual';
            draft.editor.magneticDeclination = {
              declinationCdeg: 0,
              referenceLatE7: 0,
              referenceLonE7: 0,
              referenceDate: '2026-10-16',
              source: 'legacy observation',
              referenceHeightDm: 100,
            };
            store.put(draft, 'current');
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
  await page.reload();
  await page.getByRole('button', { name: /Continue editing/ }).click();
  await confirmRoute(page);
  await step(page, 'Elevation');
  await expect(page.getByRole('radio', { name: /Use source elevation/ })).toBeChecked();
  await expect(page.locator('.issue[data-code="INCOMPLETE_ELEVATION"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeDisabled();
  await page.getByRole('radio', { name: /Fill gaps and export/ }).check();
  const exported = await downloadRoute(page);
  expect(exported.route.elevationInfo.containsFilledValues).toBe(true);
  expect(exported.route.magneticDeclination).toMatchObject({
    declinationCdeg: 0,
    source: 'legacy observation',
  });
  expect(exported.route.magneticDeclination).not.toHaveProperty('referenceHeightDm');
});

test('keeps missing endpoint elevation blocked while allowing route previews', async ({ page }) => {
  await importText(
    page,
    gpx([
      [0, 0, null],
      [0, 0.002, 110],
      [0, 0.004, null],
      [0, 0.006, 120],
    ]),
  );
  await confirmRoute(page);
  await step(page, 'Elevation');
  await expect(page.getByRole('radio', { name: /Fill gaps and export/ })).toBeChecked();
  await expect(page.locator('.issue[data-code="INCOMPLETE_ELEVATION"]')).toContainText(
    'Missing start or finish elevations',
  );
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeDisabled();
  await expect(page.getByRole('navigation').getByRole('button', { name: /Export/ })).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Route progress', exact: true })).toBeVisible();
  await page.getByRole('slider', { name: 'Route progress', exact: true }).fill('300');
});

test('warns about interior gaps filled by default and exports a complete profile', async ({
  page,
}) => {
  await importText(
    page,
    gpx([
      [0, 0, 100],
      [0, 0.002, null],
      [0, 0.004, 120],
    ]),
  );
  await confirmRoute(page);
  await step(page, 'Elevation');
  await expect(page.getByRole('radio', { name: /Fill gaps and export/ })).toBeChecked();
  await expect(page.locator('.issue[data-code="ELEVATION_LARGE_GAP"]')).toHaveCount(1);
  await expect(page.locator('.issue[data-code="INCOMPLETE_ELEVATION"]')).toHaveCount(0);
  const exported = await downloadRoute(page);
  expect(exported.route.elev[0].hDm).toBe(1000);
  expect(exported.route.elev.at(-1)!.hDm).toBe(1200);
  expect(exported.route.elevationInfo.containsFilledValues).toBe(true);
});

test('requires corrected source data when every elevation is missing', async ({ page }) => {
  await importText(page, gpx(complete.map(([lat, lon]) => [lat, lon, null])));
  await confirmRoute(page);
  await step(page, 'Elevation');
  await expect(page.getByRole('radio', { name: /Fill gaps and export/ })).toBeChecked();
  await expect(page.locator('.issue[data-code="INCOMPLETE_ELEVATION"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeDisabled();
  await expect(page.getByRole('navigation').getByRole('button', { name: /Export/ })).toBeDisabled();
  if (await page.getByRole('button', { name: 'Map', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Interactive route map', exact: true }),
  ).toBeVisible();
});

test('keeps KML altitude uncertainty explicit and records accepted provenance', async ({
  page,
}) => {
  await importText(
    page,
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>KML hill</name><LineString><coordinates>0,0,100 0.0001,0,110 0.0002,0,120</coordinates></LineString></Placemark></kml>',
    'hill.kml',
  );
  await confirmRoute(page);
  await step(page, 'Elevation');
  await page.getByRole('radio', { name: /Use source elevation/ }).check();
  const acceptance = page
    .locator('.panel-footer')
    .getByRole('checkbox', { name: /I confirm these values/ });
  await expect(
    page.locator('.panel-fields').getByRole('checkbox', { name: /I confirm these values/ }),
  ).toHaveCount(0);
  await expect(page.locator('.issue[data-code="ELEVATION_UNCONFIRMED"]')).toHaveCount(0);
  await expect(acceptance).not.toBeChecked();
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeDisabled();
  await expect(page.getByRole('navigation').getByRole('button', { name: /Export/ })).toBeDisabled();
  await step(page, 'Elevation');
  await acceptance.check();
  await expect(page.getByRole('button', { name: 'Next: Review', exact: true })).toBeEnabled();
  // Keep a real replacement import pending to exercise the fixed footer's busy lock.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      const args = options === undefined ? [message] : [message, options];
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'import'
      ) {
        setTimeout(() => Reflect.apply(original, this, args), 1500);
      } else Reflect.apply(original, this, args);
    };
  });
  await page.getByLabel('Choose route file', { exact: true }).setInputFiles({
    name: 'replacement.gpx',
    mimeType: 'application/xml',
    buffer: Buffer.from(gpx(complete)),
  });
  await expect(page.locator('.busy-banner')).toContainText('Reading your route…');
  await expect(acceptance).toBeDisabled();
  await expect(acceptance).toBeChecked();
  await expect(page.getByRole('button', { name: 'Next: Review', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.busy-banner')).toHaveCount(0);
  await expect(acceptance).toBeEnabled();
  await expect(acceptance).toBeChecked();
  const exported = await downloadRoute(page);
  expect(exported.route.elevationInfo).toMatchObject({ verticalDatum: 0, quality: 1 });
  expect(exported.route.elev!.at(-1)!.upDm).toBe(200);
});

for (const extension of ['gpx', 'kml']) {
  test(`imports and exports real EMY20K.${extension} with explicitly confirmed stations`, async ({
    page,
    isMobile,
  }) => {
    await page
      .getByLabel('Choose route file', { exact: true })
      .setInputFiles(
        fileURLToPath(new URL(`../fixtures/routes/2026MY/EMY20K.${extension}`, import.meta.url)),
      );
    await expect(page.getByLabel('Route name', { exact: true })).toBeVisible();
    await expect(page.locator('.source-file')).toContainText('1,898');
    await confirmRoute(page);
    const rows = page.locator('.station-row');
    expect(await rows.count()).toBeGreaterThan(2);
    for (let index = 0; index < (await rows.count()); index++) {
      await rows.nth(index).click();
      const confirm = page.getByRole('button', { name: 'Confirm station position', exact: true });
      if (await confirm.count()) await confirm.click();
    }
    await step(page, 'Elevation');
    await page.getByRole('radio', { name: /Fill gaps and export/ }).check();
    if (extension === 'kml')
      await page.getByRole('checkbox', { name: /I confirm these values/ }).check();
    if (isMobile) {
      if (await page.getByRole('button', { name: 'Profile', exact: true }).isVisible())
        await page.getByRole('button', { name: 'Profile', exact: true }).click();
      await expect(page.getByRole('slider', { name: 'Route progress', exact: true })).toBeVisible();
    }
    if (await page.getByRole('button', { name: 'Map', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Map', exact: true }).click();
    await expect(page.locator('.map-panel')).toBeVisible();
    if (isMobile) {
      const mapBounds = await page.locator('.route-map').boundingBox();
      const panelBounds = await page.locator('.map-panel').boundingBox();
      expect(mapBounds!.height).toBeLessThanOrEqual(panelBounds!.height);
    }
    const drawingBounds = await page
      .locator('.maplibregl-canvas, .route-map__sketch')
      .first()
      .boundingBox();
    expect(drawingBounds!.height).toBeGreaterThan(isMobile ? 120 : 200);
    expect(drawingBounds!.width).toBeGreaterThan(200);
    if (await page.getByRole('button', { name: 'Fit entire route', exact: true }).count()) {
      await expect(
        page.getByRole('button', { name: 'Fit entire route', exact: true }),
      ).toBeInViewport({ ratio: 1 });
    }
    await noOverflow(page);
    const exported = await downloadRoute(page);
    expect(exported.route.totalSDm).toBeGreaterThan(150_000);
    expect(exported.route.totalSDm).toBeLessThan(300_000);
    expect(exported.route.stations.length).toBeGreaterThan(2);
    expect(exported.route.elev.length).toBeGreaterThan(2);
    expect(exported.route.elev[0].sDm).toBe(0);
    expect(exported.route.elev.at(-1)!.sDm).toBe(exported.route.totalSDm);
    expect(exported.route.elevationInfo.containsFilledValues).toBe(true);
  });
}

test('switches and remembers the locale without changing route data or export identity', async ({
  page,
}) => {
  await importText(page, gpx(complete));
  const first = await downloadRoute(page);
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
  await expect(page.locator('.panel-heading h2')).toHaveText('导出');
  if (await page.getByRole('button', { name: '地图', exact: true }).isVisible())
    await page.getByRole('button', { name: '地图', exact: true }).click();
  await expect(page.getByRole('region', { name: '交互式路线地图' })).toBeVisible();
  await expect(page.locator('.title-row')).toHaveCount(0);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 .rte', exact: true }).click();
  const downloadedPath = await (await downloadPromise).path();
  expect(new Uint8Array(await readFile(downloadedPath!))).toEqual(first.bytes);
  await page.reload();
  await expect(page.getByRole('combobox', { name: '语言', exact: true })).toHaveValue('zh');
  await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  await expect(page.getByRole('button', { name: 'Choose a file', exact: true })).toBeVisible();
  await noOverflow(page);
});

test('restored diagnostics follow the selected language without displaying raw codes', async ({
  page,
}) => {
  await importText(page, gpx(complete));
  await expect(
    page.getByRole('status', { name: 'Saved on this device', exact: true }),
  ).toBeVisible();
  // Restore stored diagnostics with distinct counts to check interpolation.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('trl-x-route-studio');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('drafts', 'readwrite');
          const store = tx.objectStore('drafts');
          const current = store.get('current');
          current.onsuccess = () => {
            const draft = current.result;
            draft.editor.reference.issues = [
              { code: 'DUPLICATE_COORDINATES', severity: 'warning', params: { count: 5 } },
              { code: 'ELEVATION_CONFLICT', severity: 'warning', params: { count: 1 } },
              { code: 'ELEVATION_MISSING', severity: 'warning', params: { count: 8 } },
              { code: 'LARGE_SOURCE_EDGE', severity: 'warning', params: { count: 2 } },
            ];
            store.put(draft, 'current');
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
  await page.reload();
  await page.getByRole('button', { name: /Continue editing/ }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh');
  const notes = page.locator('.issues-list');
  await expect(notes.locator('summary')).toHaveCount(0);
  await expect(notes.locator('.issue strong')).toHaveText(['路线点间距过大']);
  await expect(notes).toContainText('2 段相邻源坐标相距超过 1 km');
  await expect(notes).not.toContainText('高程');
  await expect(notes).not.toContainText('重复坐标');
  await expect(notes).not.toContainText('Count:');
  await expect(notes).not.toContainText('DUPLICATE_COORDINATES');
  await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  await expect(notes.locator('.issue').first()).toContainText('Count: 2.');
  await expect(notes.locator('.issue strong').first()).toHaveText('Large gap between route points');
  await confirmRoute(page);
  await step(page, 'Review');
  await expect(page.locator('.issues-list')).toHaveCount(0);
  const reportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download processing report', exact: true }).click();
  const report = JSON.parse(await readFile((await (await reportDownload).path())!, 'utf8'));
  expect(report.issues.map((issue: { code: string }) => issue.code)).toEqual([
    'DUPLICATE_COORDINATES',
    'ELEVATION_CONFLICT',
    'ELEVATION_MISSING',
    'LARGE_SOURCE_EDGE',
  ]);
  expect(report.issues[0].message).toContain('Count: 5.');
});

test('magnetic declination survives drafts and exports as optional metadata', async ({ page }) => {
  await importText(page, gpx(complete));
  await expect(
    page.getByRole('heading', { name: 'Magnetic declination', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Declination source', exact: true })
    .selectOption('manual');
  await page.getByRole('checkbox', { name: 'Include magnetic declination', exact: true }).check();
  await expect(
    page.getByText('Invalid magnetic declination metadata', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Declination (°)', { exact: true }).pressSequentially('-3.50');
  await expect(page.getByLabel('Declination (°)', { exact: true })).toHaveValue('-3.50');
  await page.getByLabel('Reference date (UTC)', { exact: true }).fill('2026-10-16');
  await page.getByLabel('Model/version or observation source', { exact: true }).fill('synthetic');
  await expect(
    page.getByLabel('WGS84 ellipsoid height (m, optional)', { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Valid from (UTC, inclusive)', { exact: true }).fill('2026-10-16');
  await page.getByLabel('Valid until (UTC, inclusive)', { exact: true }).fill('2027-10-15');
  await expect(
    page.getByText('Invalid magnetic declination metadata', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('status', { name: 'Saved on this device', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Continue editing/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Magnetic declination', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Declination (°)', { exact: true })).toHaveValue('-3.5');
  const output = await downloadRoute(page);
  expect(output.route.magneticDeclination).toEqual({
    declinationCdeg: -350,
    referenceLatE7: 0,
    referenceLonE7: 0,
    referenceDate: '2026-10-16',
    source: 'synthetic',
    validFrom: '2026-10-16',
    validUntil: '2027-10-15',
  });
  await step(page, 'Route');
  await expect(
    page.getByRole('heading', { name: 'Magnetic declination', exact: true }),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: 'Include magnetic declination', exact: true }).uncheck();
  const omitted = await downloadRoute(page);
  expect(omitted.route.magneticDeclination).toBeUndefined();
});

function bgsResult(url: URL, declination = -7.464) {
  return {
    'geomagnetic-field-model-result': {
      model: 'wmm',
      model_revision: '2025',
      date: { value: url.searchParams.get('date') },
      coordinates: {
        latitude: { value: Number(url.searchParams.get('latitude')) },
        longitude: { value: Number(url.searchParams.get('longitude')) },
        altitude: { value: 0 },
      },
      'field-value': { declination: { units: 'deg (east)', value: declination } },
    },
  };
}

test('automatically fetches declination and removes the old value when a subsequent lookup fails', async ({
  page,
}) => {
  const requests: URL[] = [];
  let online = true;
  await page.route('https://geomag.bgs.ac.uk/web_service/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (!online) {
      await route.abort();
      return;
    }
    await route.fulfill({ json: bgsResult(url) });
  });
  await importText(page, gpx(complete));
  await expect(
    page.getByRole('heading', { name: 'Magnetic declination', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Declination source', exact: true })).toHaveValue(
    'auto',
  );
  await page.getByLabel('Calculation date (UTC)', { exact: true }).fill('2026-10-16');
  const available = page.getByRole('status').filter({ hasText: 'Reference fetched:' });
  await expect(available).toHaveText('Reference fetched: -7.46°');
  await expect(available).not.toContainText('WMM2025');
  await expect(available).not.toContainText('2026-10-16');
  const output = await downloadRoute(page);
  expect(output.route.magneticDeclination).toMatchObject({
    declinationCdeg: -746,
    source: 'WMM2025 / BGS',
    referenceDate: '2026-10-16',
  });
  expect(output.route.magneticDeclination).not.toHaveProperty('referenceHeightDm');
  expect(output.route.magneticDeclination).not.toHaveProperty('validUntil');
  expect(requests.at(-1)!.searchParams.get('altitude')).toBe('0');
  online = false;
  await step(page, 'Route');
  await expect(
    page.getByRole('heading', { name: 'Magnetic declination', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Calculation date (UTC)', { exact: true }).fill('2026-10-17');
  await expect(
    page.getByRole('status').filter({ hasText: 'Magnetic declination unavailable' }),
  ).toBeVisible();
  const missing = await downloadRoute(page);
  expect(missing.route.magneticDeclination).toBeUndefined();
});

test('offline automatic lookup leaves optional metadata absent and still allows export', async ({
  page,
}) => {
  await importText(page, gpx(complete));
  await expect(
    page.getByRole('heading', { name: 'Magnetic declination', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Magnetic declination unavailable' }),
  ).toBeVisible();
  const missing = await downloadRoute(page);
  expect(missing.route.magneticDeclination).toBeUndefined();
});

test('a late automatic declination response cannot overwrite a manual value', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('https://geomag.bgs.ac.uk/web_service/**', async (route) => {
    requested = true;
    await pending;
    await route.fulfill({ json: bgsResult(new URL(route.request().url()), 15) }).catch(() => {});
  });
  await importText(page, gpx(complete));
  await expect.poll(() => requested).toBe(true);
  await expect(
    page.getByRole('heading', { name: 'Magnetic declination', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Declination source', exact: true })
    .selectOption('manual');
  await page.getByRole('checkbox', { name: 'Include magnetic declination', exact: true }).check();
  await page.getByLabel('Declination (°)', { exact: true }).fill('0');
  await page.getByLabel('Reference date (UTC)', { exact: true }).fill('2026-10-16');
  await page
    .getByLabel('Model/version or observation source', { exact: true })
    .fill('manual observation');
  release();
  const output = await downloadRoute(page);
  expect(output.route.magneticDeclination).toMatchObject({
    declinationCdeg: 0,
    source: 'manual observation',
  });
});

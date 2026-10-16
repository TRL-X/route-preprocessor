import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

async function expectWindowSizedEditor(page: Page) {
  const bounds = await page.evaluate(() => {
    const root = document.documentElement;
    const rect = (selector: string) => {
      const { top, bottom } = document.querySelector(selector)!.getBoundingClientRect();
      return { top, bottom };
    };
    return { height: innerHeight, content: root.scrollHeight, scroll: window.scrollY,
      footer: rect('.panel-footer'), steps: rect('.stepper'), preview: rect('.visual-workspace') };
  });
  expect(bounds.content).toBeLessThanOrEqual(bounds.height + 1);
  expect(bounds.scroll).toBe(0);
  for (const rect of [bounds.footer, bounds.steps, bounds.preview]) {
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(bounds.height);
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('https://tiles.openfreemap.org/**', route => route.abort());
  await page.route('https://geomag.bgs.ac.uk/web_service/**', route => route.abort());
  await page.goto('/');
  await page.getByLabel('Choose route file', { exact: true }).setInputFiles(fileURLToPath(new URL('../fixtures/routes/2026MY/EMY20K.gpx', import.meta.url)));
  await expect(page.getByLabel('Route name', { exact: true })).toBeVisible();
});

test('expanded processing notes can scroll to their final item at the reported window size', async ({ page, isMobile }, testInfo) => {
  await page.setViewportSize({ width: 865, height: 600 });
  await page.getByLabel('Choose route file', { exact: true }).setInputFiles({
    name: 'gaps.gpx', mimeType: 'application/xml',
    buffer: Buffer.from('<gpx><trk><name>Check route connections</name><trkseg><trkpt lat="0" lon="0"><ele>100</ele></trkpt><trkpt lat="0" lon="0.02"><ele>110</ele></trkpt><trkpt lat="0.01" lon="0.04"><ele>120</ele></trkpt></trkseg></trk></gpx>'),
  });
  await expect(page.locator('.issue[data-code="LARGE_SOURCE_EDGE"]')).toBeVisible();
  const notes = page.locator('.issues-list');
  await expect(notes.locator('summary')).toHaveCount(0);
  await expect(notes.locator('.issue').first()).toBeVisible();
  const body = page.locator('.panel-body');
  const dimensions = await body.evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight }));
  expect(dimensions.content).toBeGreaterThan(dimensions.height);
  // Test actual input, not an assignment to scrollTop that can hide browser bugs.
  if (isMobile) {
    await body.press('End');
  } else {
    await body.hover();
    await page.mouse.wheel(0, 1800);
  }
  await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await body.press('End');
  await expect.poll(() => notes.locator('.issue').last().evaluate(el => {
    const region = el.closest('.panel-body')!;
    return el.getBoundingClientRect().bottom <= region.getBoundingClientRect().bottom;
  })).toBe(true);
  const confirmation = page.getByRole('checkbox', { name: 'I have checked the route and direction on the map.' });
  await expect(confirmation).toBeInViewport();
  expect((await confirmation.boundingBox())!.y).toBeGreaterThanOrEqual((await notes.boundingBox())!.y + (await notes.boundingBox())!.height);
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expectWindowSizedEditor(page);
  await page.screenshot({ path: testInfo.outputPath('processing-notes-scroll.png'), fullPage: true });
});

test('editing stays inside the window when settings expand or the window is resized', async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 900 }, { width: 865, height: 827 },
    { width: 1024, height: 600 }, { width: 844, height: 390 },
    { width: 390, height: 844 }, { width: 390, height: 667 },
  ]) {
    await page.setViewportSize(viewport);
    for (const details of await page.locator('.advanced').all()) {
      if (await details.getAttribute('open') === null) await details.locator('summary').click();
    }
    const body = page.locator('.panel-body');
    // Resizing and async content can change overflow before keyboard scrolling settles.
    await expect.poll(async () => {
      await body.press('End');
      return body.evaluate(el => el.scrollHeight <= el.clientHeight || el.scrollTop > 0);
    }).toBe(true);
    await expectWindowSizedEditor(page);
    // Returning to the first field must scroll only its own pane.
    await page.getByLabel('Route name', { exact: true }).fill('A route name that is much longer than the available title space '.repeat(3));
    await expectWindowSizedEditor(page);
  }
});

test('map and profile switch content at wide, intermediate, and phone widths', async ({ page }, testInfo) => {
  for (const width of [1440, 865, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(page.locator('.map-panel')).toBeHidden();
    await expect(page.locator('.profile-panel')).toBeVisible();
    expect(await page.locator('.profile-panel').evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('slider', { name: 'Route progress', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Profile', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const progress = page.getByRole('slider', { name: 'Route progress', exact: true });
    await progress.fill('8000');
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await expect(page.locator('.profile-panel')).toBeHidden();
    await expect(page.locator('.map-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const canvas = page.locator('.maplibregl-canvas, .route-map__sketch').first();
    await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThan(width > 760 ? 200 : 120);
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(progress).toHaveValue('8000');
    const bounds = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.viewport + 1);
    if (width === 865) await page.screenshot({ path: testInfo.outputPath('profile-tab-865.png'), fullPage: true });
  }
});

test('tall preview panes show map and profile together and preserve the cursor when resized', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 939, height: 827 });
  await expect(page.locator('.visual-workspace')).toHaveClass(/visual-workspace--stacked/);
  await expect(page.locator('.view-switch')).toHaveCount(0);
  await expect(page.locator('.workspace-toolbar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Basemap', exact: true })).toHaveCount(0);
  await expect(page.locator('.map-panel')).toBeVisible();
  await expect(page.locator('.profile-panel')).toBeVisible();
  const map = (await page.locator('.map-panel').boundingBox())!;
  const profile = (await page.locator('.profile-panel').boundingBox())!;
  expect(map.height).toBeGreaterThanOrEqual(300);
  expect(await page.locator('.profile-panel').evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  const slider = (await page.locator('.route-progress').boundingBox())!;
  expect(slider.y).toBeGreaterThanOrEqual(profile.y + profile.height - 1);
  await expect(page.getByRole('slider', { name: 'Route progress', exact: true })).toBeInViewport();
  expect(profile.y).toBeGreaterThanOrEqual(map.y + map.height - 1);
  const progress = page.getByRole('slider', { name: 'Route progress', exact: true });
  await progress.fill('8000');
  await expect(page.locator('.title-row')).toHaveCount(0);
  await expect(page.locator('.issues-list')).toHaveCount(0);
  await expectWindowSizedEditor(page);
  await page.screenshot({ path: testInfo.outputPath('stacked-preview.png'), fullPage: true });
  await page.setViewportSize({ width: 939, height: 650 });
  await expect(page.locator('.view-switch')).toBeVisible();
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.locator('.map-panel')).toBeHidden();
  await expect(progress).toHaveValue('8000');
  await page.setViewportSize({ width: 939, height: 827 });
  await expect(page.locator('.view-switch')).toHaveCount(0);
  await expect(page.locator('.workspace-toolbar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Basemap', exact: true })).toHaveCount(0);
  await expect(page.locator('.map-panel')).toBeVisible();
  await expect(progress).toHaveValue('8000');
  await expectWindowSizedEditor(page);
});

test('phone preview can be collapsed for editing and reopened without losing the cursor', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  const progress = page.getByRole('slider', { name: 'Route progress', exact: true });
  await progress.fill('8000');
  const body = page.locator('.panel-body');
  const expandedHeight = (await body.boundingBox())!.height;
  await page.getByRole('button', { name: 'Collapse preview', exact: true }).click();
  await expect(page.locator('.profile-panel')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Expand preview', exact: true })).toHaveAttribute('aria-expanded', 'false');
  expect((await body.boundingBox())!.height).toBeGreaterThan(expandedHeight + 150);
  await body.press('End');
  await expect.poll(() => body.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThan(2);
  await expectWindowSizedEditor(page);
  await page.screenshot({ path: testInfo.outputPath('phone-editor.png'), fullPage: true });
  // View selection also reopens the preview, including after a breakpoint change.
  await page.setViewportSize({ width: 865, height: 827 });
  await expect(page.locator('.profile-panel')).toBeVisible();
  await expectWindowSizedEditor(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.map-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(progress).toHaveValue('8000');
  await expectWindowSizedEditor(page);
  await page.screenshot({ path: testInfo.outputPath('phone-profile.png'), fullPage: true });
});

test('the import screen scrolls inside the shell on a short phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await page.getByRole('navigation').getByRole('button', { name: /Import/ }).click();
  await page.locator('.privacy-note').scrollIntoViewIfNeeded();
  const bounds = await page.evaluate(() => ({
    height: innerHeight, content: document.documentElement.scrollHeight,
    scroll: window.scrollY, mainScroll: document.querySelector('.main-shell')!.scrollTop,
    noteBottom: document.querySelector('.privacy-note')!.getBoundingClientRect().bottom,
  }));
  expect(bounds.content).toBeLessThanOrEqual(bounds.height + 1);
  expect(bounds.scroll).toBe(0);
  expect(bounds.mainScroll).toBeGreaterThan(0);
  expect(bounds.noteBottom).toBeLessThanOrEqual(bounds.height + 1);
  await page.getByRole('button', { name: 'Choose a file', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Choose a file', exact: true })).toBeInViewport();
});

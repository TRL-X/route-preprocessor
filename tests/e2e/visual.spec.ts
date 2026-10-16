import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test('captures the actual EMY20K route and elevation editor', async ({ page, isMobile }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-webkit', 'The two handoff images use the desktop and mobile Chromium projects.');
  // Keep CI independent of the public basemap; local visual QA also checks the live provider.
  if (process.env.CI) await page.route('https://tiles.openfreemap.org/**', route => route.abort());
  await page.goto('/');
  await page.getByLabel('Choose route file', { exact: true }).setInputFiles(fileURLToPath(new URL('../fixtures/routes/2026MY/EMY20K.gpx', import.meta.url)));
  await expect(page.getByLabel('Route name', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'I have checked the route and direction on the map.' }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  for (const row of await page.locator('.station-row').all()) {
    await row.click();
    const confirm = page.getByRole('button', { name: 'Confirm station position', exact: true });
    if (await confirm.count()) await confirm.click();
  }
  await page.getByRole('navigation', { name: 'Route preparation steps' }).getByRole('button', { name: /Elevation/ }).click();
  await page.getByRole('radio', { name: /Fill gaps and export/ }).check();
  await expect(page.locator('.visual-workspace')).toHaveAttribute('aria-busy', 'false');
  // The real sample may have unfillable endpoint gaps. The source profile remains visible.
  if (await page.locator('.issue.error').count()) {
    await page.getByRole('radio', { name: /Omit elevation/ }).check();
    await expect(page.locator('.visual-workspace')).toHaveAttribute('aria-busy', 'false');
  }
  if (await page.getByRole('button', { name: 'Profile', exact: true }).isVisible()) await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await page.getByRole('slider', { name: 'Route progress', exact: true }).fill('8000');
  if (await page.getByRole('button', { name: 'Map', exact: true }).isVisible()) await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.maplibregl-ctrl-attrib a[href*="openfreemap"], .route-map__status').first()).toBeAttached({ timeout: 20_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => { /* A slow basemap cannot block route editing. */ });
  const canvas = await page.locator('.maplibregl-canvas, .route-map__sketch').first().boundingBox();
  expect(canvas!.width).toBeGreaterThan(250);
  expect(canvas!.height).toBeGreaterThan(isMobile ? 120 : 250);
  const bounds = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  expect(bounds.page).toBeLessThanOrEqual(bounds.viewport + 1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(`trl-x-route-studio-${isMobile ? 'mobile' : 'desktop'}.png`), fullPage: true, animations: 'disabled' });
});

import { expect, test } from '@playwright/test';
import { DRAFT_VERSION } from '../../src/app/editor';

const source =
  '<gpx><trk><name>Recovery route</name><trkseg>' +
  '<trkpt lat="0" lon="0"><ele>10</ele></trkpt>' +
  '<trkpt lat="0" lon="0.001"><ele>20</ele></trkpt>' +
  '</trkseg></trk></gpx>';

for (const corruption of ['old version', 'future version', 'invalid reference'] as const) {
  test(`rejects a draft with ${corruption} without overwriting it or blocking import`, async ({
    page,
  }) => {
    await page.route('https://tiles.openfreemap.org/**', (route) => route.abort());
    await page.route('https://geomag.bgs.ac.uk/web_service/**', (route) => route.abort());
    await page.goto('/');
    const file = { name: 'recovery.gpx', mimeType: 'application/xml', buffer: Buffer.from(source) };
    await page.getByLabel('Choose route file', { exact: true }).setInputFiles(file);
    await expect(
      page.getByRole('status', { name: 'Saved on this device', exact: true }),
    ).toBeVisible();

    const stored = await page.evaluate(
      ({ corruption, version }) =>
        new Promise<string>((resolve, reject) => {
          const request = indexedDB.open('trl-x-route-studio');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction('drafts', 'readwrite');
            const store = transaction.objectStore('drafts');
            const current = store.get('current');
            let snapshot = '';
            current.onsuccess = () => {
              const draft = current.result;
              if (corruption === 'old version') draft.version = 1;
              else if (corruption === 'future version') draft.version = version + 1;
              else draft.editor.reference.points[0].s = 'not-a-distance';
              snapshot = JSON.stringify(draft);
              store.put(draft, 'current');
            };
            transaction.oncomplete = () => {
              db.close();
              resolve(snapshot);
            };
            transaction.onerror = () => {
              db.close();
              reject(transaction.error);
            };
          };
        }),
      { corruption, version: DRAFT_VERSION },
    );

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Import route file' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(/draft/i);
    await expect(page.getByRole('button', { name: /Continue editing/ })).toHaveCount(0);
    const unchanged = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const request = indexedDB.open('trl-x-route-studio');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const current = db.transaction('drafts').objectStore('drafts').get('current');
            current.onsuccess = () => {
              db.close();
              resolve(JSON.stringify(current.result));
            };
            current.onerror = () => {
              db.close();
              reject(current.error);
            };
          };
        }),
    );
    expect(unchanged).toBe(stored);

    await page.getByLabel('Choose route file', { exact: true }).setInputFiles(file);
    await expect(page.getByLabel('Route name', { exact: true })).toHaveValue('Recovery route');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

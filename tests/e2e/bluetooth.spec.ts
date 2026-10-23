import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decodeRte } from '../../src/core/rte';

const serviceUuid = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
const characteristicUuid = 'da2e7828-fbce-4e01-ae9e-261174997c48';
const source =
  '<gpx version="1.1"><trk><name>Bluetooth forest trail</name><trkseg>' +
  '<trkpt lat="0" lon="0"><ele>100</ele></trkpt>' +
  '<trkpt lat="0" lon="0.0002"><ele>110</ele></trkpt>' +
  '<trkpt lat="0.0001" lon="0.0004"><ele>105</ele></trkpt>' +
  '<trkpt lat="0" lon="0.0006"><ele>125</ele></trkpt>' +
  '</trkseg></trk></gpx>';

interface BluetoothHarness {
  writes: number;
  name: string;
  length: number;
  bytes: number[];
}

/** Test-side BLE peer; it decodes the wire independently of the application codec. */
async function installBluetooth(page: Page, supported = true) {
  await page.addInitScript(
    ({ supported, serviceUuid, characteristicUuid }) => {
      if (!supported) {
        Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: undefined });
        return;
      }

      let buffered: number[] = [];
      let connected = false;
      const harness: BluetoothHarness = {
        writes: 0,
        name: '',
        length: 0,
        bytes: [],
      };
      Object.defineProperty(window, '__bluetoothTest', { value: harness });

      type CborItem = number | string | Uint8Array | Record<string, unknown>;
      function decode(bytes: Uint8Array): CborItem {
        let offset = 0;
        function item(): CborItem {
          const first = bytes[offset++];
          const major = first >>> 5;
          const info = first & 31;
          let count = info;
          if (info >= 24) {
            if (info > 26) throw new Error('Unsupported test CBOR argument.');
            count = 0;
            for (let i = 0; i < 2 ** (info - 24); i++) count = count * 256 + bytes[offset++];
          }
          if (major === 0) return count;
          if (major === 2 || major === 3) {
            const content = bytes.slice(offset, offset + count);
            offset += count;
            return major === 2 ? content : new TextDecoder().decode(content);
          }
          if (major === 5) {
            const result: Record<string, unknown> = {};
            for (let i = 0; i < count; i++) result[String(item())] = item();
            return result;
          }
          throw new Error('Unsupported test CBOR item.');
        }
        const result = item();
        if (offset !== bytes.length) throw new Error('Trailing test CBOR data.');
        return result;
      }
      function encodeResponse(value: number): Uint8Array {
        const head = [0xa1, 0x63, 0x6f, 0x66, 0x66]; // { off: value }
        if (value < 24) return Uint8Array.from([...head, value]);
        if (value <= 0xff) return Uint8Array.from([...head, 0x18, value]);
        if (value <= 0xffff) return Uint8Array.from([...head, 0x19, value >>> 8, value & 255]);
        return Uint8Array.from([
          ...head,
          0x1a,
          value >>> 24,
          (value >>> 16) & 255,
          (value >>> 8) & 255,
          value & 255,
        ]);
      }

      const device = new EventTarget();
      const characteristic = Object.assign(new EventTarget(), {
        properties: { writeWithoutResponse: true, notify: true },
        value: new DataView(new ArrayBuffer(0)),
        async startNotifications() {
          return characteristic;
        },
        async writeValueWithoutResponse(value: BufferSource) {
          if (!connected) throw new DOMException('Device disconnected.', 'NetworkError');
          const bytes = ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(value);
          harness.writes++;
          buffered.push(...bytes);
          while (buffered.length >= 8) {
            const length = buffered[2] * 256 + buffered[3];
            if (buffered.length < 8 + length) return;
            const request = Uint8Array.from(buffered.splice(0, 8 + length));
            const payload = decode(request.subarray(8)) as Record<string, unknown>;
            const op = request[0] & 7;
            const group = request[4] * 256 + request[5];
            const id = request[7];
            const off = Number(payload.off ?? 0);
            const data = payload.data instanceof Uint8Array ? payload.data : new Uint8Array();
            if (op !== 2 || group !== 8 || id !== 0) throw new Error('Expected SMP file upload.');
            if (off === 0) {
              harness.name = String(payload.name);
              harness.length = Number(payload.len);
              harness.bytes = [];
            }
            if (off !== harness.bytes.length) throw new Error('Unexpected file offset.');
            harness.bytes.push(...data);
            const response = encodeResponse(off + data.length);
            const packet = Uint8Array.from([
              (request[0] & 0x18) | 3,
              0,
              response.length >>> 8,
              response.length & 255,
              request[4],
              request[5],
              request[6],
              id,
              ...response,
            ]);
            queueMicrotask(() => {
              // Notifications need not line up with SMP header or payload boundaries.
              for (let offset = 0; offset < packet.length; offset += 7) {
                const fragment = packet.slice(offset, offset + 7);
                characteristic.value = new DataView(fragment.buffer);
                characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
              }
            });
          }
        },
      });
      const service = {
        async getCharacteristic(uuid: string) {
          if (uuid !== characteristicUuid) throw new Error('Unexpected characteristic.');
          return characteristic;
        },
      };
      const gatt = {
        get connected() {
          return connected;
        },
        async connect() {
          connected = true;
          return gatt;
        },
        async getPrimaryService(uuid: string) {
          if (uuid !== serviceUuid) throw new Error('Unexpected service.');
          return service;
        },
        disconnect() {
          if (!connected) return;
          connected = false;
          buffered = [];
          device.dispatchEvent(new Event('gattserverdisconnected'));
        },
      };
      Object.assign(device, { name: 'Route test device', id: 'route-test-device', gatt });
      Object.defineProperty(navigator, 'bluetooth', {
        configurable: true,
        value: {
          async requestDevice() {
            return device;
          },
        },
      });
    },
    { supported, serviceUuid, characteristicUuid },
  );
}

async function openExport(page: Page) {
  await page.getByLabel('Choose route file', { exact: true }).setInputFiles({
    name: 'bluetooth-forest.gpx',
    mimeType: 'application/xml',
    buffer: Buffer.from(source),
  });
  await expect(page.getByLabel('Route name', { exact: true })).toBeVisible();
  await page
    .getByRole('checkbox', { name: 'I have checked the route and direction on the map.' })
    .check();
  await visitExport(page);
}

async function visitExport(page: Page) {
  for (const step of ['Stations', 'Elevation', 'Review', 'Export']) {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: new RegExp(step) })
      .click();
    await expect(page.locator('.panel-heading h2')).toHaveText(step);
  }
}

async function received(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __bluetoothTest: BluetoothHarness }).__bluetoothTest,
  );
}

test.beforeEach(async ({ page }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.abort());
  await page.route('https://geomag.bgs.ac.uk/web_service/**', (route) => route.abort());
});

test('unsupported browsers keep route download available and explain Bluetooth support', async ({
  page,
}) => {
  await installBluetooth(page, false);
  await page.goto('/');
  await openExport(page);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeEnabled();
  const send = page.getByRole('button', { name: 'Send to device', exact: true });
  const upload = page.getByRole('region', { name: 'Bluetooth upload', exact: true });
  await expect(send).toHaveAttribute('aria-expanded', 'false');
  await expect(send).toHaveAttribute('aria-controls', /\S+/);
  const panelId = await send.getAttribute('aria-controls');
  await expect(page.locator(`[id="${panelId}"]`)).toBeAttached();
  await expect(upload).toBeHidden();
  await send.click();
  await expect(send).toHaveAttribute('aria-expanded', 'true');
  await expect(upload).toContainText('Bluetooth upload requires Chrome on a computer or Android.');
  await expect(upload.getByRole('button', { name: 'Connect device', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'File details', exact: true })).toBeVisible();
  await send.click();
  await expect(send).toHaveAttribute('aria-expanded', 'false');
  await expect(upload).toBeHidden();
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeEnabled();
});

test('preserves the device connection and directory across toggles and downloads, then uploads the same bytes', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Bluetooth upload targets desktop and Android Chrome.');
  await installBluetooth(page);
  await page.goto('/');
  await openExport(page);
  const send = page.getByRole('button', { name: 'Send to device', exact: true });
  await send.click();
  const upload = page.getByRole('region', { name: 'Bluetooth upload', exact: true });
  const directory = upload.getByRole('textbox', { name: 'Target directory', exact: true });
  await expect(directory).toHaveValue('/SD:/ROUTES/');
  const filename = page.getByRole('textbox', { name: 'File name', exact: true });
  await expect(filename).toHaveValue(/^[A-Z]{8}\.RTE$/);
  await expect(upload).toContainText(`/SD:/ROUTES/${await filename.inputValue()}`);
  await expect(upload.getByRole('button', { name: 'Upload route', exact: true })).toBeDisabled();
  await directory.fill('/SD:/custom-routes/');
  await expect(
    page.getByRole('status', { name: 'Saved on this device', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Continue editing/ }).click();
  await page
    .getByRole('checkbox', { name: 'I have checked the route and direction on the map.' })
    .check();
  await visitExport(page);
  await expect(send).toHaveAttribute('aria-expanded', 'false');
  await send.click();
  await expect(directory).toHaveValue('/SD:/custom-routes/');

  await upload.getByRole('button', { name: 'Connect device', exact: true }).click();
  await expect(upload).toContainText('Connected to Route test device');
  for (const invalid of ['', '../escape']) {
    await filename.fill(invalid);
    await expect(filename).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeDisabled();
    await expect(upload.getByRole('button', { name: 'Upload route', exact: true })).toBeDisabled();
  }
  await filename.fill('Evening trail.rte');
  await expect(upload).toContainText('/SD:/custom-routes/Evening trail.RTE');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .rte', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Evening trail.RTE');
  const bytes = new Uint8Array(await readFile((await download.path())!));
  const route = decodeRte(bytes);
  expect(route.name).toBe('Bluetooth forest trail');
  expect(route.stages).toEqual([{ fromEventId: 1, toEventId: 2, minHDm: 1000, maxHDm: 1250 }]);
  await expect(send).toHaveAttribute('aria-expanded', 'true');
  await expect(upload).toContainText('Connected to Route test device');
  await expect(
    page.getByRole('button', { name: 'Download processing report', exact: true }),
  ).toBeVisible();
  await send.click();
  await expect(send).toHaveAttribute('aria-expanded', 'false');
  await expect(upload).toBeHidden();
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeEnabled();
  await send.click();
  await expect(upload).toContainText('Connected to Route test device');
  await expect(directory).toHaveValue('/SD:/custom-routes/');
  await upload.getByRole('button', { name: 'Upload route', exact: true }).click();
  const path = `/SD:/custom-routes/${download.suggestedFilename()}`;
  await expect(upload).toContainText(`Uploaded to ${path}`);
  const peer = await received(page);
  expect(peer.name).toBe(path);
  expect(peer.length).toBe(bytes.length);
  expect(Uint8Array.from(peer.bytes)).toEqual(bytes);
  await send.click();
  await send.click();
  await expect(upload).toContainText(`Uploaded to ${path}`);
});

test('cancels while preparing the RTE without sending Bluetooth data or leaving navigation locked', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Bluetooth upload targets desktop and Android Chrome.');
  await installBluetooth(page);
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
        setTimeout(() => {
          Object.assign(window, { __delayedExportSent: true });
          Reflect.apply(original, this, args);
        }, 1500);
      } else Reflect.apply(original, this, args);
    };
  });
  await page.goto('/');
  await openExport(page);
  const send = page.getByRole('button', { name: 'Send to device', exact: true });
  await send.click();
  const upload = page.getByRole('region', { name: 'Bluetooth upload', exact: true });
  await upload.getByRole('button', { name: 'Connect device', exact: true }).click();
  await upload.getByRole('button', { name: 'Upload route', exact: true }).click();
  await expect(upload).toContainText('Generating and validating the RTE file');
  await expect(page.getByRole('textbox', { name: 'File name', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeDisabled();
  await expect(send).toBeDisabled();
  await expect(upload.getByRole('button', { name: 'Cancel upload', exact: true })).toBeEnabled();
  await expect(page.getByRole('navigation').getByRole('button', { name: /Route/ })).toBeDisabled();
  await upload.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  await expect(upload).toContainText('Upload cancelled.');
  await expect(page.getByRole('navigation').getByRole('button', { name: /Route/ })).toBeEnabled();
  await expect(send).toBeEnabled();
  await expect(send).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Download .rte', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'File name', exact: true })).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __delayedExportSent?: boolean }).__delayedExportSent,
      ),
    )
    .toBe(true);
  expect((await received(page)).writes).toBe(0);
});

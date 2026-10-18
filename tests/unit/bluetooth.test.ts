import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectBluetoothDevice,
  isBluetoothSupported,
  SMP_CHARACTERISTIC_UUID,
  SMP_SERVICE_UUID,
  validateUploadPath,
} from '../../src/device/bluetooth';
import { decodeSmpCbor, encodeSmpCbor } from '../../src/device/smp-cbor';
import type { SmpFields, SmpMap } from '../../src/device/smp-cbor';
import { SmpDeviceError, SmpReassembler } from '../../src/device/smp';
import type { SmpPacket } from '../../src/device/smp';

class FakeCharacteristic extends EventTarget {
  properties = { writeWithoutResponse: true, notify: true };
  value?: DataView;
  writes: Uint8Array[] = [];
  requests: { packet: SmpPacket; data: SmpMap }[] = [];
  parser = new SmpReassembler();
  reply: ((packet: SmpPacket, data: SmpMap) => void) | null = (packet, data) => {
    this.notify(packet, { off: (data.off as number) + (data.data as Uint8Array).length });
  };
  beforeWrite?: () => Promise<void>;
  afterWrite?: () => Promise<void>;
  startNotifications = vi.fn(async () => this);
  writeValueWithoutResponse = vi.fn(async (value: BufferSource) => {
    await this.beforeWrite?.();
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.writes.push(bytes.slice());
    for (const packet of this.parser.push(bytes)) {
      const data = decodeSmpCbor(packet.data) as SmpMap;
      this.requests.push({ packet, data });
      this.reply?.(packet, data);
    }
    await this.afterWrite?.();
  });
  notify(
    packet: SmpPacket,
    data: SmpFields | Uint8Array,
    change: Partial<SmpPacket> & { version?: number } = {},
  ) {
    const payload = data instanceof Uint8Array ? data : encodeSmpCbor(data);
    const response = { ...packet, version: 0, op: 3, ...change };
    const frame = new Uint8Array(8 + payload.length);
    frame.set([
      (response.version << 3) | response.op,
      0,
      payload.length >>> 8,
      payload.length & 255,
      response.group >>> 8,
      response.group & 255,
      response.sequence,
      response.command,
    ]);
    frame.set(payload, 8);
    // Split even the header and use a DataView with a non-zero byteOffset.
    for (let i = 0; i < frame.length; i += 3) this.notifyRaw(frame.slice(i, i + 3));
  }
  notifyRaw(bytes: Uint8Array) {
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes, 2);
    this.value = new DataView(padded.buffer, 2, bytes.length);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class FakeDevice extends EventTarget {
  name = 'Route watch';
  id = 'fake-watch';
  characteristic = new FakeCharacteristic();
  gatt = {
    connected: false,
    connect: vi.fn(async () => {
      this.gatt.connected = true;
      return this.gatt;
    }),
    disconnect: vi.fn(() => {
      if (!this.gatt.connected) return;
      this.gatt.connected = false;
      this.characteristic.parser.clear();
      this.dispatchEvent(new Event('gattserverdisconnected'));
    }),
    getPrimaryService: vi.fn(async (_uuid: string) => ({
      getCharacteristic: vi.fn(async (_characteristicUuid: string) => this.characteristic),
    })),
  };
}

let device: FakeDevice;
let requestDevice: ReturnType<typeof vi.fn>;
const uploadOptions = () => ({ signal: new AbortController().signal, onProgress: vi.fn() });
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};

beforeEach(() => {
  device = new FakeDevice();
  requestDevice = vi.fn(async () => device);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { bluetooth: { requestDevice } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('requests a device synchronously, subscribes to SMP and reports its name', async () => {
  expect(isBluetoothSupported()).toBe(true);
  const promise = connectBluetoothDevice();
  expect(requestDevice).toHaveBeenCalledWith({
    acceptAllDevices: true,
    optionalServices: [SMP_SERVICE_UUID],
  });
  const connection = await promise;
  expect(connection.name).toBe('Route watch');
  expect(device.gatt.getPrimaryService).toHaveBeenCalledWith(SMP_SERVICE_UUID);
  const service = await device.gatt.getPrimaryService.mock.results[0].value;
  expect(service.getCharacteristic).toHaveBeenCalledWith(SMP_CHARACTERISTIC_UUID);
  expect(device.characteristic.startNotifications).toHaveBeenCalledOnce();
  connection.disconnect();
});

it('only advances progress on matching ACKs and uploads all bytes in bounded chunks', async () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, index) => index & 255);
  const options = uploadOptions();
  device.characteristic.reply = (packet, data) => {
    expect(options.onProgress).not.toHaveBeenCalledWith(bytes.length, bytes.length);
    const ack = { off: (data.off as number) + (data.data as Uint8Array).length };
    device.characteristic.notify(
      packet,
      { off: bytes.length },
      { sequence: (packet.sequence + 1) & 255 },
    );
    device.characteristic.notify(packet, ack, { version: 1 });
  };
  const connection = await connectBluetoothDevice();
  await connection.upload(bytes, '/lfs/routes/example.rte', options);
  const requests = device.characteristic.requests;
  expect(new Set(requests.map(({ packet }) => packet.sequence)).size).toBe(requests.length);
  expect(requests[0].data.len).toBe(300);
  expect(requests.every(({ data }) => data.name === '/lfs/routes/example.rte')).toBe(true);
  expect(Uint8Array.from(requests.flatMap(({ data }) => [...(data.data as Uint8Array)]))).toEqual(
    bytes,
  );
  expect(device.characteristic.writes.every((write) => write.length <= 20)).toBe(true);
  expect(options.onProgress.mock.calls).toEqual([
    [0, 300],
    ...requests.map(({ data }) => [(data.off as number) + (data.data as Uint8Array).length, 300]),
  ]);
  connection.disconnect();
});

it('reduces file chunks so a long path still fits in a 256-byte SMP request', async () => {
  const connection = await connectBluetoothDevice();
  await connection.upload(new Uint8Array(160), '/' + 'x'.repeat(199), uploadOptions());
  expect(device.characteristic.requests.length).toBeGreaterThan(1);
  expect(device.characteristic.requests.every(({ packet }) => packet.data.length + 8 <= 256)).toBe(
    true,
  );
  connection.disconnect();
});

it.each([
  [{ rc: 5 }, { code: 5, group: null }],
  // Device v2 error: { err: { group: 8, rc: 12 } }.
  [
    Uint8Array.of(
      0xa1,
      0x63,
      101,
      114,
      114,
      0xa2,
      0x65,
      103,
      114,
      111,
      117,
      112,
      8,
      0x62,
      114,
      99,
      12,
    ),
    { code: 12, group: 8 },
  ],
])('reports v1 and v2 device error details', async (payload, details) => {
  device.characteristic.reply = (packet) => device.characteristic.notify(packet, payload);
  const connection = await connectBluetoothDevice();
  const promise = connection.upload(new Uint8Array(10), '/lfs/a.rte', uploadOptions());
  await expect(promise).rejects.toBeInstanceOf(SmpDeviceError);
  await expect(promise).rejects.toMatchObject({ message: 'bluetooth.deviceError', ...details });
});

it('rejects ACK offsets that stall or skip data without completing', async () => {
  for (const off of [0, 11]) {
    device.characteristic.reply = (packet) => device.characteristic.notify(packet, { off });
    const connection = await connectBluetoothDevice();
    const options = uploadOptions();
    await expect(connection.upload(new Uint8Array(10), '/lfs/a.rte', options)).rejects.toThrow(
      'bluetooth.invalidOffset',
    );
    expect(options.onProgress).toHaveBeenCalledExactlyOnceWith(0, 10);
    expect(device.gatt.connected).toBe(false);
  }
});

it('waits for the final ACK, supports cancellation and ignores late responses', async () => {
  device.characteristic.reply = null;
  const disconnected = vi.fn();
  const connection = await connectBluetoothDevice({ onDisconnected: disconnected });
  const controller = new AbortController();
  const progress = vi.fn();
  const promise = connection.upload(new Uint8Array(10), '/lfs/a.rte', {
    signal: controller.signal,
    onProgress: progress,
  });
  const result = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  await flush();
  expect(device.characteristic.requests).toHaveLength(1);
  expect(progress).toHaveBeenCalledExactlyOnceWith(0, 10);
  controller.abort();
  await result;
  device.characteristic.notify(device.characteristic.requests[0].packet, { off: 10 });
  expect(progress).toHaveBeenCalledExactlyOnceWith(0, 10);
  expect(disconnected).toHaveBeenCalledOnce();
  expect(device.gatt.connected).toBe(false);
});

it('waits for the last GATT write to settle even if the final ACK arrives first', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  device.characteristic.afterWrite = () =>
    device.characteristic.requests.length ? blocked : Promise.resolve();
  const connection = await connectBluetoothDevice();
  const options = uploadOptions();
  let complete = false;
  const promise = connection.upload(new Uint8Array(10), '/lfs/a.rte', options).then(() => {
    complete = true;
  });
  await flush();
  expect(device.characteristic.requests).toHaveLength(1);
  expect(complete).toBe(false);
  expect(options.onProgress).toHaveBeenCalledExactlyOnceWith(0, 10);
  release();
  await promise;
  expect(options.onProgress).toHaveBeenLastCalledWith(10, 10);
  connection.disconnect();
});

it.each(['resolve', 'reject'])(
  'keeps an old native write from affecting a reconnected device after abort: %s',
  async (settlement) => {
    let release!: () => void;
    let fail!: () => void;
    const oldCharacteristic = device.characteristic;
    oldCharacteristic.beforeWrite = () =>
      new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = () => reject(new DOMException('Old connection closed', 'NetworkError'));
      });
    const oldDisconnected = vi.fn();
    const oldConnection = await connectBluetoothDevice({ onDisconnected: oldDisconnected });
    const controller = new AbortController();
    const oldUpload = oldConnection.upload(new Uint8Array(300), '/lfs/a.rte', {
      signal: controller.signal,
      onProgress: vi.fn(),
    });
    const cancelled = expect(oldUpload).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    device.characteristic = new FakeCharacteristic();
    const newDisconnected = vi.fn();
    const newConnection = await connectBluetoothDevice({ onDisconnected: newDisconnected });
    if (settlement === 'resolve') release();
    else fail();
    await flush();
    expect(oldCharacteristic.writeValueWithoutResponse).toHaveBeenCalledOnce();
    expect(oldDisconnected).toHaveBeenCalledOnce();
    expect(newDisconnected).not.toHaveBeenCalled();
    expect(device.gatt.connected).toBe(true);
    await expect(
      newConnection.upload(new Uint8Array(10), '/lfs/new.rte', uploadOptions()),
    ).resolves.toBeUndefined();
    newConnection.disconnect();
  },
);

it('times out on missing or mismatched responses and closes the connection', async () => {
  vi.useFakeTimers();
  device.characteristic.reply = (packet) =>
    device.characteristic.notify(packet, { off: 10 }, { group: 9 });
  const connection = await connectBluetoothDevice();
  const promise = connection.upload(new Uint8Array(10), '/lfs/a.rte', uploadOptions());
  const result = expect(promise).rejects.toThrow('bluetooth.timeout');
  await vi.advanceTimersByTimeAsync(10001);
  await result;
  expect(device.gatt.connected).toBe(false);
});

it('rejects a pending transfer on disconnection and only notifies once', async () => {
  device.characteristic.reply = null;
  const disconnected = vi.fn();
  const connection = await connectBluetoothDevice({ onDisconnected: disconnected });
  const promise = connection.upload(new Uint8Array(10), '/lfs/a.rte', uploadOptions());
  const result = expect(promise).rejects.toThrow('bluetooth.disconnected');
  device.gatt.disconnect();
  await result;
  connection.disconnect();
  expect(disconnected).toHaveBeenCalledOnce();
});

it('rejects malformed CBOR and oversized notification frames', async () => {
  for (const notification of [
    Uint8Array.of(3, 0, 0, 1, 0, 8, 0, 0, 0xff),
    Uint8Array.of(3, 0, 0x20, 0, 0, 8, 0, 0),
  ]) {
    const connection = await connectBluetoothDevice();
    device.characteristic.reply = () => device.characteristic.notifyRaw(notification);
    await expect(
      connection.upload(new Uint8Array(10), '/lfs/a.rte', uploadOptions()),
    ).rejects.toThrow('bluetooth.invalidResponse');
  }
});

it('rejects a second transfer and pre-aborted transfers without sending data', async () => {
  device.characteristic.reply = null;
  const connection = await connectBluetoothDevice();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    connection.upload(new Uint8Array(10), '/lfs/a.rte', {
      signal: cancelled.signal,
      onProgress: vi.fn(),
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(device.characteristic.writes).toHaveLength(0);
  const promise = connection.upload(new Uint8Array(10), '/lfs/a.rte', uploadOptions());
  const result = expect(promise).rejects.toThrow('bluetooth.disconnected');
  await expect(
    connection.upload(new Uint8Array(10), '/lfs/b.rte', uploadOptions()),
  ).rejects.toThrow('bluetooth.busy');
  connection.disconnect();
  await result;
});

it('translates browser capability, chooser cancellation and service failures', async () => {
  vi.stubGlobal('isSecureContext', false);
  expect(isBluetoothSupported()).toBe(false);
  await expect(connectBluetoothDevice()).rejects.toThrow('bluetooth.unsupported');
  vi.stubGlobal('isSecureContext', true);
  requestDevice.mockRejectedValueOnce(new DOMException('Cancelled', 'NotFoundError'));
  await expect(connectBluetoothDevice()).rejects.toThrow('bluetooth.selectionCancelled');
  device.characteristic.properties.notify = false;
  await expect(connectBluetoothDevice()).rejects.toThrow('bluetooth.serviceUnavailable');
  expect(device.gatt.connected).toBe(false);
});

it('validates path budgets before connecting, including the largest offset encoding', () => {
  expect(() => validateUploadPath('/' + 'x'.repeat(214))).not.toThrow();
  expect(() => validateUploadPath('/' + 'x'.repeat(215))).toThrow('bluetooth.pathTooLong');
});

describe('the separate SMP CBOR codec', () => {
  it('decodes a Zephyr-style indefinite map and known byte-string request', () => {
    expect(decodeSmpCbor(Uint8Array.of(0xbf, 0x63, 111, 102, 102, 0x18, 128, 0xff))).toEqual({
      off: 128,
    });
    expect(encodeSmpCbor({ off: 0, data: Uint8Array.of(1, 2) })).toEqual(
      Uint8Array.of(0xa2, 0x63, 111, 102, 102, 0, 0x64, 100, 97, 116, 97, 0x42, 1, 2),
    );
  });
  it('rejects duplicate map keys and truncated CBOR containers', () => {
    for (const bytes of [
      [0xa2, 0x61, 97, 0, 0x61, 97, 1], // duplicate map key
      [0xbf, 0x63, 111, 102, 102, 0], // missing break
      [0x5a, 0xff, 0xff, 0xff, 0xff], // truncated byte string
    ])
      expect(() => decodeSmpCbor(Uint8Array.from(bytes))).toThrow('bluetooth.invalidResponse');
  });
});

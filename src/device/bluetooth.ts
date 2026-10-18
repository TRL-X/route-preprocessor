import type { SmpMap } from './smp-cbor';
import { decodeSmpResponse, encodeSmpRequest, SmpReassembler } from './smp';

export const SMP_SERVICE_UUID = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
export const SMP_CHARACTERISTIC_UUID = 'da2e7828-fbce-4e01-ae9e-261174997c48';
const WRITE_BYTES = 20; // ATT MTU 23 is guaranteed; Web Bluetooth exposes no negotiated MTU.
const REQUEST_BYTES = 256;
const FILE_CHUNK_BYTES = 128;
const REQUEST_TIMEOUT_MS = 10000;

// Minimal local Web Bluetooth types avoid adding ambient APIs to unrelated code.
interface Characteristic extends EventTarget {
  value?: DataView;
  properties: { writeWithoutResponse: boolean; notify: boolean };
  startNotifications(): Promise<unknown>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
}
interface GattServer {
  connected: boolean;
  connect(): Promise<GattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<{
    getCharacteristic(uuid: string): Promise<Characteristic>;
  }>;
}
interface Device extends EventTarget {
  name?: string;
  id: string;
  gatt?: GattServer;
}
interface BluetoothApi {
  requestDevice(options: { acceptAllDevices: true; optionalServices: string[] }): Promise<Device>;
}

export interface BluetoothConnection {
  readonly name: string;
  disconnect(): void;
  upload(
    bytes: Uint8Array,
    path: string,
    options: {
      signal: AbortSignal;
      onProgress: (sent: number, total: number) => void;
    },
  ): Promise<void>;
}

function bluetoothApi(): BluetoothApi | undefined {
  return typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth;
}

export function isBluetoothSupported(): boolean {
  return globalThis.isSecureContext === true && typeof bluetoothApi()?.requestDevice === 'function';
}

export function validateUploadPath(path: string): void {
  if (
    !path.startsWith('/') ||
    path.endsWith('/') ||
    /[\u0000-\u001f\u007f-\u009f\\]/u.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('bluetooth.invalidPath');
  // Budget for the largest integer encodings, so later chunks always fit as well.
  if (
    new TextEncoder().encode(path).length > 255 ||
    encodeSmpRequest(0, { off: 0xffffffff, len: 0xffffffff, name: path, data: Uint8Array.of(0) })
      .length > REQUEST_BYTES
  )
    throw new Error('bluetooth.pathTooLong');
}

// requestDevice runs before the first await to preserve the button's user activation.
export async function connectBluetoothDevice(
  options: { onDisconnected?: () => void } = {},
): Promise<BluetoothConnection> {
  if (!isBluetoothSupported()) throw new Error('bluetooth.unsupported');
  let device: Device;
  try {
    device = await bluetoothApi()!.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SMP_SERVICE_UUID],
    });
  } catch (error) {
    throw new Error(
      error instanceof DOMException && error.name === 'NotFoundError'
        ? 'bluetooth.selectionCancelled'
        : 'bluetooth.connectionFailed',
    );
  }
  if (!device.gatt) throw new Error('bluetooth.serviceUnavailable');
  let connection: Connection | undefined;
  try {
    const server = await device.gatt.connect().catch(() => {
      throw new Error('bluetooth.connectionFailed');
    });
    const service = await server.getPrimaryService(SMP_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(SMP_CHARACTERISTIC_UUID);
    if (
      !characteristic.properties.writeWithoutResponse ||
      !characteristic.properties.notify ||
      typeof characteristic.writeValueWithoutResponse !== 'function'
    )
      throw new Error('bluetooth.serviceUnavailable');
    connection = new Connection(device, characteristic, options.onDisconnected);
    await characteristic.startNotifications();
    connection.assertConnected();
    return connection;
  } catch (error) {
    connection?.disconnect();
    device.gatt.disconnect();
    if (error instanceof Error && error.message.startsWith('bluetooth.')) throw error;
    throw new Error('bluetooth.serviceUnavailable');
  }
}

interface PendingRequest {
  sequence: number;
  sent: boolean;
  response?: SmpMap;
  resolve: (value: SmpMap) => void;
  reject: (reason: unknown) => void;
}

class Connection implements BluetoothConnection {
  readonly name: string;
  private active = true;
  private uploading = false;
  private sequence = 0;
  private pending: PendingRequest | null = null;
  private parser = new SmpReassembler();

  constructor(
    private device: Device,
    private characteristic: Characteristic,
    private onDisconnected?: () => void,
  ) {
    this.name = device.name || device.id;
    characteristic.addEventListener('characteristicvaluechanged', this.receive);
    device.addEventListener('gattserverdisconnected', this.disconnected);
  }

  assertConnected() {
    if (!this.active || !this.device.gatt?.connected) {
      const error = new Error('bluetooth.disconnected');
      this.close(error);
      throw error;
    }
  }

  private close(reason: unknown) {
    if (!this.active) return;
    this.active = false;
    this.pending?.reject(reason);
    this.parser.clear();
    this.characteristic.removeEventListener('characteristicvaluechanged', this.receive);
    this.device.removeEventListener('gattserverdisconnected', this.disconnected);
    this.device.gatt?.disconnect();
    this.onDisconnected?.();
  }

  private disconnected = () => this.close(new Error('bluetooth.disconnected'));

  disconnect() {
    this.close(new Error('bluetooth.disconnected'));
  }

  private receive = () => {
    const value = this.characteristic.value;
    if (!value || !this.active) return;
    try {
      const packets = this.parser.push(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      );
      for (const packet of packets) {
        const pending = this.pending;
        if (
          !pending ||
          packet.sequence !== pending.sequence ||
          packet.op !== 3 ||
          packet.group !== 8 ||
          packet.command !== 0
        )
          continue;
        pending.response = decodeSmpResponse(packet);
        if (pending.sent) pending.resolve(pending.response);
      }
    } catch (error) {
      this.close(error);
    }
  };

  private async request(frame: Uint8Array, sequence: number): Promise<SmpMap> {
    this.assertConnected();
    const timer = setTimeout(() => this.close(new Error('bluetooth.timeout')), REQUEST_TIMEOUT_MS);
    try {
      return await new Promise<SmpMap>((resolve, reject) => {
        const pending: PendingRequest = { sequence, sent: false, resolve, reject };
        this.pending = pending;
        const send = async () => {
          for (let offset = 0; offset < frame.length; offset += WRITE_BYTES) {
            this.assertConnected();
            await this.characteristic.writeValueWithoutResponse(
              frame.slice(offset, offset + WRITE_BYTES).buffer,
            );
          }
          this.assertConnected();
          pending.sent = true;
          if (pending.response) pending.resolve(pending.response);
        };
        void send().catch(() => this.close(new Error('bluetooth.transferFailed')));
      });
    } finally {
      clearTimeout(timer);
      this.pending = null;
    }
  }

  async upload(
    bytes: Uint8Array,
    path: string,
    {
      signal,
      onProgress,
    }: {
      signal: AbortSignal;
      onProgress: (sent: number, total: number) => void;
    },
  ): Promise<void> {
    if (this.uploading) throw new Error('bluetooth.busy');
    this.assertConnected();
    signal.throwIfAborted();
    if (!bytes.length) throw new Error('bluetooth.emptyFile');
    validateUploadPath(path);
    this.uploading = true;
    const abort = () => this.close(new DOMException('Upload cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      let offset = 0;
      onProgress(0, bytes.length);
      while (offset < bytes.length) {
        signal.throwIfAborted();
        this.assertConnected();
        let length = Math.min(FILE_CHUNK_BYTES, bytes.length - offset);
        const sequence = this.sequence++ & 255;
        const makeFrame = () =>
          encodeSmpRequest(sequence, {
            off: offset,
            data: bytes.subarray(offset, offset + length),
            name: path,
            ...(offset === 0 ? { len: bytes.length } : {}),
          });
        let frame = makeFrame();
        while (frame.length > REQUEST_BYTES && length > 0) {
          length--;
          frame = makeFrame();
        }
        if (length === 0) throw new Error('bluetooth.pathTooLong');
        const response = await this.request(frame, sequence);
        signal.throwIfAborted();
        // Require an ACK for exactly the bytes sent. Never skip data or report queued writes.
        if (response.off !== offset + length) {
          const error = new Error('bluetooth.invalidOffset');
          this.close(error);
          throw error;
        }
        offset = response.off;
        onProgress(offset, bytes.length);
      }
    } finally {
      signal.removeEventListener('abort', abort);
      this.uploading = false;
    }
  }
}

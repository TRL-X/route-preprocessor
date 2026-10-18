import { decodeSmpCbor, encodeSmpCbor, isSmpMap } from './smp-cbor';
import type { SmpFields, SmpMap } from './smp-cbor';

export interface SmpPacket {
  op: number;
  group: number;
  sequence: number;
  command: number;
  data: Uint8Array;
}

export class SmpDeviceError extends Error {
  constructor(
    readonly code: number,
    readonly group: number | null = null,
  ) {
    super('bluetooth.deviceError');
    this.name = 'SmpDeviceError';
  }
}

export function encodeSmpRequest(sequence: number, data: SmpFields): Uint8Array {
  const payload = encodeSmpCbor(data);
  const frame = new Uint8Array(8 + payload.length);
  // Legacy v1 requests retain compatibility with older devices; decode both versions.
  frame.set([2, 0, payload.length >>> 8, payload.length & 255, 0, 8, sequence, 0]);
  frame.set(payload, 8);
  return frame;
}

// Bluetooth fragments contain no extra framing. The first SMP header gives the size.
// https://docs.zephyrproject.org/latest/services/device_mgmt/smp_transport.html
export class SmpReassembler {
  private buffer: Uint8Array = new Uint8Array();

  clear() {
    this.buffer = new Uint8Array();
  }

  push(fragment: Uint8Array): SmpPacket[] {
    if (this.buffer.length + fragment.length > 8192) throw new Error('bluetooth.invalidResponse');
    const joined = new Uint8Array(this.buffer.length + fragment.length);
    joined.set(this.buffer);
    joined.set(fragment, this.buffer.length);
    this.buffer = joined;
    const packets: SmpPacket[] = [];
    while (this.buffer.length >= 8) {
      const b = this.buffer;
      const length = b[2] * 256 + b[3];
      const version = (b[0] >>> 3) & 3;
      if ((b[0] & 0xe0) !== 0 || version > 1 || b[1] !== 0 || length > 4096)
        throw new Error('bluetooth.invalidResponse');
      if (b.length < 8 + length) break;
      packets.push({
        op: b[0] & 7,
        group: b[4] * 256 + b[5],
        sequence: b[6],
        command: b[7],
        data: b.slice(8, 8 + length),
      });
      this.buffer = b.slice(8 + length);
    }
    return packets;
  }
}

export function decodeSmpResponse(packet: SmpPacket): SmpMap {
  const value = decodeSmpCbor(packet.data);
  if (!isSmpMap(value)) throw new Error('bluetooth.invalidResponse');
  if (value.rc !== undefined) {
    if (typeof value.rc !== 'number' || !Number.isInteger(value.rc))
      throw new Error('bluetooth.invalidResponse');
    if (value.rc !== 0) throw new SmpDeviceError(value.rc);
  }
  if (value.err !== undefined) {
    const error = value.err;
    if (
      !isSmpMap(error) ||
      typeof error.rc !== 'number' ||
      !Number.isInteger(error.rc) ||
      error.rc < 0 ||
      typeof error.group !== 'number' ||
      !Number.isInteger(error.group) ||
      error.group < 0
    )
      throw new Error('bluetooth.invalidResponse');
    if (error.rc !== 0) throw new SmpDeviceError(error.rc, error.group);
  }
  return value;
}

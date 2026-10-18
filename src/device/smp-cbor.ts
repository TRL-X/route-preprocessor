// SMP uses text map keys and indefinite maps; keep it separate from the RTE codec.
type SmpValue = number | string | Uint8Array | boolean | null | SmpMap | SmpValue[];
export type SmpFields = Record<string, number | string | Uint8Array>;
export interface SmpMap {
  [key: string]: SmpValue;
}

const MAX_BYTES = 4096;
const MAX_ITEMS = 512;
const MAX_DEPTH = 8;
const invalid = (): never => {
  throw new Error('bluetooth.invalidResponse');
};

/** File-upload requests contain one flat map of unsigned integers, text and bytes. */
export function encodeSmpCbor(value: SmpFields): Uint8Array {
  const output: number[] = [];
  const head = (major: number, n: number) => {
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) invalid();
    if (n < 24) output.push((major << 5) | n);
    else if (n <= 0xff) output.push((major << 5) | 24, n);
    else if (n <= 0xffff) output.push((major << 5) | 25, n >>> 8, n & 255);
    else output.push((major << 5) | 26, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  };
  const write = (item: number | string | Uint8Array) => {
    if (typeof item === 'number') head(0, item);
    else {
      const bytes = typeof item === 'string' ? new TextEncoder().encode(item) : item;
      if (bytes.length > MAX_BYTES) invalid();
      head(typeof item === 'string' ? 3 : 2, bytes.length);
      output.push(...bytes);
    }
    if (output.length > MAX_BYTES) invalid();
  };
  const entries = Object.entries(value);
  head(5, entries.length);
  for (const [key, item] of entries) {
    write(key);
    write(item);
  }
  return Uint8Array.from(output);
}

export function decodeSmpCbor(bytes: Uint8Array): SmpValue {
  if (bytes.length > MAX_BYTES) invalid();
  let offset = 0;
  let items = 0;
  const byte = () => {
    if (offset >= bytes.length) invalid();
    return bytes[offset++];
  };
  const read = (depth: number): SmpValue => {
    if (depth > MAX_DEPTH || ++items > MAX_ITEMS) invalid();
    const first = byte();
    const major = first >>> 5;
    const info = first & 31;
    if (major === 7) {
      if (info === 20 || info === 21) return info === 21;
      if (info === 22) return null;
      return invalid();
    }
    const indefinite = info === 31;
    let length = info;
    if (info >= 24 && !indefinite) {
      if (info > 26) invalid();
      length = 0;
      for (let i = 0; i < 2 ** (info - 24); i++) length = length * 256 + byte();
    }
    if (major === 0 || major === 1) {
      if (indefinite) invalid();
      return major === 0 ? length : -1 - length;
    }
    if (major === 2 || major === 3) {
      if (indefinite || length > bytes.length - offset) invalid();
      const data = bytes.slice(offset, offset + length);
      offset += length;
      if (major === 2) return data;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        return invalid();
      }
    }
    if (major !== 4 && major !== 5) return invalid();
    if (!indefinite && length > MAX_ITEMS) invalid();
    const map: SmpMap = Object.create(null);
    const array: SmpValue[] = [];
    let count = 0;
    while (indefinite ? bytes[offset] !== 0xff : count < length) {
      const keyOrValue = read(depth + 1);
      if (major === 4) array.push(keyOrValue);
      else {
        if (typeof keyOrValue !== 'string' || Object.hasOwn(map, keyOrValue)) return invalid();
        map[keyOrValue] = read(depth + 1);
      }
      count++;
    }
    if (indefinite) byte();
    return major === 4 ? array : map;
  };
  const value = read(0);
  if (offset !== bytes.length) invalid();
  return value;
}

export function isSmpMap(value: SmpValue): value is SmpMap {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

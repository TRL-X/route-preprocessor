/** Restricted deterministic CBOR profile used by TRL-X META (spec §7.1). */
export type CborValue = number | boolean | null | string | Uint8Array | CborValue[] | Map<number, CborValue>;
export type RteErrorCode = 'invalid' | 'unsupported' | 'resource' | 'unavailable' | 'range';

export class RteError extends Error {
  constructor(public readonly code: RteErrorCode, message: string) {
    super(message);
    this.name = 'RteError';
  }
}

export const CBOR_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 16,
  maxItems: 200_000,
  maxContainerItems: 100_000,
});

export function invalid(message: string): never { throw new RteError('invalid', message); }
export function resource(message: string): never { throw new RteError('resource', message); }

const utf8Encoder = new TextEncoder();
// ignoreBOM preserves U+FEFF as data instead of silently consuming a leading BOM.
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function textBytes(value: string): Uint8Array {
  if (value.includes('\0')) invalid('Text contains U+0000.');
  // TextEncoder replaces lone UTF-16 surrogates; reject them instead of changing data.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('Text contains an unpaired UTF-16 surrogate.');
    } else if (c >= 0xdc00 && c <= 0xdfff) invalid('Text contains an unpaired UTF-16 surrogate.');
  }
  return utf8Encoder.encode(value);
}

/** No generic object conversion: numeric maps make ordering and duplicate checks explicit. */
export function encodeCbor(value: CborValue): Uint8Array {
  const output: number[] = [];
  let items = 0;
  function head(major: number, n: number) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) invalid('CBOR argument exceeds u32.');
    if (n < 24) output.push((major << 5) | n);
    else if (n <= 0xff) output.push((major << 5) | 24, n);
    else if (n <= 0xffff) output.push((major << 5) | 25, n >>> 8, n & 255);
    else output.push((major << 5) | 26, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  }
  function write(item: CborValue, depth: number): void {
    if (depth > CBOR_LIMITS.maxDepth) resource('META exceeds the CBOR nesting limit.');
    if (++items > CBOR_LIMITS.maxItems) resource('META exceeds the CBOR item limit.');
    if (item === null) output.push(0xf6);
    else if (typeof item === 'boolean') output.push(item ? 0xf5 : 0xf4);
    else if (typeof item === 'number') {
      if (!Number.isInteger(item) || item < -0x80000000 || item > 0xffffffff) invalid('CBOR integer is outside the allowed range.');
      head(item < 0 ? 1 : 0, item < 0 ? -1 - item : item);
    } else if (typeof item === 'string') {
      const bytes = textBytes(item);
      if (bytes.length > 512) invalid('CBOR text exceeds the profile limit of 512 bytes.');
      head(3, bytes.length);
      for (const byte of bytes) output.push(byte);
    } else if (item instanceof Uint8Array) {
      if (item.length > 1024) invalid('CBOR byte string exceeds the profile limit of 1024 bytes.');
      head(2, item.length);
      for (const byte of item) output.push(byte);
    } else if (Array.isArray(item)) {
      if (item.length > CBOR_LIMITS.maxContainerItems) resource('CBOR array exceeds the item limit.');
      head(4, item.length);
      for (const child of item) write(child, depth + 1);
    } else if (item instanceof Map) {
      if (item.size > CBOR_LIMITS.maxContainerItems) resource('CBOR map exceeds the item limit.');
      head(5, item.size);
      const entries = [...item.entries()].sort(([a], [b]) => a - b);
      for (const [key, child] of entries) {
        if (!Number.isInteger(key) || key < 0 || key > 65535) invalid('CBOR map key is outside 0..65535.');
        write(key, depth + 1);
        write(child, depth + 1);
      }
    } else invalid('Value is not permitted in the META CBOR profile.');
    if (output.length > CBOR_LIMITS.maxBytes) resource('META exceeds the byte limit.');
  }
  write(value, 0);
  return Uint8Array.from(output);
}

export function decodeCbor(bytes: Uint8Array): CborValue {
  if (bytes.length > CBOR_LIMITS.maxBytes) resource('META exceeds the byte limit.');
  let offset = 0;
  let items = 0;
  function need(count: number) {
    if (count > bytes.length - offset) invalid('Truncated CBOR item.');
  }
  function argument(info: number): number {
    if (info < 24) return info;
    if (info > 26) invalid('CBOR uses an indefinite, reserved, or nonminimal argument.');
    const count = 2 ** (info - 24);
    need(count);
    let n = 0;
    for (let i = 0; i < count; i++) n = n * 256 + bytes[offset++];
    if ((info === 24 && n < 24) || (info === 25 && n <= 255) || (info === 26 && n <= 65535)) {
      invalid('CBOR integer or length is not minimally encoded.');
    }
    return n;
  }
  function read(depth: number): CborValue {
    if (depth > CBOR_LIMITS.maxDepth) resource('META exceeds the CBOR nesting limit.');
    if (++items > CBOR_LIMITS.maxItems) resource('META exceeds the CBOR item limit.');
    need(1);
    const initial = bytes[offset++];
    const major = initial >>> 5;
    const info = initial & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      invalid('CBOR float, undefined, or unsupported simple value.');
    }
    if (major === 6) invalid('CBOR tags are prohibited.');
    const n = argument(info);
    if (major === 0) return n;
    if (major === 1) {
      if (n > 0x7fffffff) invalid('CBOR negative integer is outside i32.');
      return -1 - n;
    }
    if (major === 2 || major === 3) {
      if (n > (major === 3 ? 512 : 1024)) invalid('CBOR string exceeds the profile limit.');
      need(n);
      const raw = bytes.subarray(offset, offset + n);
      offset += n;
      if (major === 2) return raw.slice();
      let decoded: string;
      try { decoded = utf8Decoder.decode(raw); } catch { return invalid('CBOR text is not valid UTF-8.'); }
      if (decoded.includes('\0')) invalid('CBOR text contains U+0000.');
      return decoded;
    }
    if (n > CBOR_LIMITS.maxContainerItems) resource('CBOR container exceeds the item limit.');
    // Every child uses at least one byte; check before allocating any container.
    need(major === 5 ? n * 2 : n);
    if (major === 4) {
      const result: CborValue[] = [];
      for (let i = 0; i < n; i++) result.push(read(depth + 1));
      return result;
    }
    if (major === 5) {
      const result = new Map<number, CborValue>();
      let previous = -1;
      for (let i = 0; i < n; i++) {
        const key = read(depth + 1);
        if (typeof key !== 'number' || key < 0 || key > 65535 || key <= previous) {
          invalid('CBOR map keys must be unsigned, unique, and strictly increasing.');
        }
        previous = key;
        result.set(key, read(depth + 1));
      }
      return result;
    }
    return invalid('Unknown CBOR type.');
  }
  const result = read(0);
  if (offset !== bytes.length) invalid('META contains trailing CBOR data.');
  return result;
}

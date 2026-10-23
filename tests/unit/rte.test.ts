import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CBOR_LIMITS, decodeCbor, encodeCbor } from '../../src/core/cbor';
import type { CborValue } from '../../src/core/cbor';
import {
  convertHeading,
  queryMagneticDeclination,
  crc32,
  decodeRte,
  encodeRte,
  queryElevation,
  queryGeometry,
  RteError,
  RTE_LIMITS,
  validateRoute,
} from '../../src/core/rte';
import type { RouteData } from '../../src/core/types';

// Pinned upstream Appendix B bytes; see tests/fixtures/specification/README.md.
function loadVector(path: string): Uint8Array {
  const dump = readFileSync(new URL(`../fixtures/specification/${path}`, import.meta.url), 'utf8');
  return Uint8Array.from(
    dump
      .trimEnd()
      .split('\n')
      .flatMap((line) =>
        line
          .slice(10)
          .split(' ')
          .map((byte) => Number.parseInt(byte, 16)),
      ),
  );
}
const vectors = ['a', 'b', 'c'].map((name) => loadVector(`vector-${name}.hex`));
const [a, b, c] = vectors;

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function fixCrc(bytes: Uint8Array): Uint8Array {
  view(bytes).setUint32(44, crc32(bytes, true), true);
  return bytes;
}
function mutate(
  change: (copy: Uint8Array, dv: DataView) => void,
  input: Uint8Array = a,
): Uint8Array {
  const copy = input.slice();
  change(copy, view(copy));
  return fixCrc(copy);
}
interface TestSection {
  type: string;
  flags: number;
  version: number;
  size: number;
  count: number;
  bytes: Uint8Array;
}
function sections(bytes: Uint8Array): TestSection[] {
  const dv = view(bytes);
  return Array.from({ length: dv.getUint16(20, true) }, (_, i) => {
    const p = 64 + i * 24;
    const start = dv.getUint32(p + 8, true);
    return {
      type: String.fromCharCode(...bytes.subarray(p, p + 4)),
      flags: dv.getUint16(p + 4, true),
      version: dv.getUint16(p + 6, true),
      size: dv.getUint32(p + 16, true),
      count: dv.getUint32(p + 20, true),
      bytes: bytes.slice(start, start + dv.getUint32(p + 12, true)),
    };
  });
}
function repack(input: Uint8Array, entries: TestSection[]): Uint8Array {
  const align = (n: number) => Math.ceil(n / 4) * 4;
  let length = 64 + entries.length * 24;
  for (const entry of entries) length = align(length) + entry.bytes.length;
  const output = new Uint8Array(length);
  const dv = view(output);
  output.set(input.subarray(0, 64));
  dv.setUint32(12, length, true);
  dv.setUint16(20, entries.length, true);
  let offset = 64 + entries.length * 24;
  entries.forEach((entry, i) => {
    offset = align(offset);
    const p = 64 + i * 24;
    output.set(
      [...entry.type].map((c) => c.charCodeAt(0)),
      p,
    );
    dv.setUint16(p + 4, entry.flags, true);
    dv.setUint16(p + 6, entry.version, true);
    dv.setUint32(p + 8, offset, true);
    dv.setUint32(p + 12, entry.bytes.length, true);
    dv.setUint32(p + 16, entry.size, true);
    dv.setUint32(p + 20, entry.count, true);
    output.set(entry.bytes, offset);
    offset += entry.bytes.length;
  });
  return fixCrc(output);
}
function alterSection(
  type: string,
  change: (entry: TestSection) => void,
  input: Uint8Array = a,
): Uint8Array {
  const entries = sections(input);
  change(entries.find((entry) => entry.type === type)!);
  return repack(input, entries);
}
function alterMeta(
  change: (meta: Map<number, CborValue>) => void,
  input: Uint8Array = a,
): Uint8Array {
  return alterSection(
    'META',
    (entry) => {
      const meta = decodeCbor(entry.bytes) as Map<number, CborValue>;
      change(meta);
      entry.bytes = encodeCbor(meta);
    },
    input,
  );
}
function expectError(fn: () => unknown, code: RteError['code'] = 'invalid') {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RteError);
    expect((error as RteError).code).toBe(code);
    return;
  }
  throw new Error(`Expected RteError(${code}).`);
}

describe('normative reference vectors and CRC32', () => {
  it('loads all three complete pinned upstream reference fixtures', () => {
    expect(vectors).toHaveLength(3);
    expect(c.length).toBe(432);
    expect(view(c).getUint32(44, true)).toBe(0xad71ed27);
    expect(a.length).toBe(492);
    expect(b.length).toBe(492);
    expect(view(a).getUint32(44, true)).toBe(0x9f58f1aa);
    expect(view(b).getUint32(44, true)).toBe(0x8861c349);
    expect(vectors.map((bytes) => createHash('sha256').update(bytes).digest('hex'))).toEqual([
      '1eb37069ffd714b38fd8d6f3b2b2778b6ab09b4c05b800b9029d40c3bb06056b',
      'a47447193984ecc17e03d003a65d48a670435318d329d2ef12aa3fc6a15279d7',
      '4bd9ae982090760817d2358296032093c80cae0acd1649d941772ddd08338dfd',
    ]);
  });
  it('matches the standard empty and 123456789 check values', () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(a, true)).toBe(0x9f58f1aa);
    expect(crc32(b, true)).toBe(0x8861c349);
    expect(crc32(c, true)).toBe(0xad71ed27);
  });
  it.each([
    ['A', 0],
    ['B', 1],
    ['C', 2],
  ] as const)('decodes and exactly reproduces vector %s', (_, index) => {
    const route = decodeRte(vectors[index]);
    expect(route.name).toBe('Test');
    expect(route.totalSDm).toBe(20000);
    expect(route.revision).toBe([8, 12, 13][index]);
    expect(route.routeId).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
    expect(route.stations.map((station) => station.name)).toEqual(['Start', 'CP1', 'Finish']);
    expect(route.stages).toEqual([
      { fromEventId: 1, toEventId: 2, minHDm: 900, maxHDm: 1200 },
      { fromEventId: 2, toEventId: 3, minHDm: 900, maxHDm: 1400 },
    ]);
    expect(encodeRte(route)).toEqual(vectors[index]);
  });
  it('supports a Uint8Array with a nonzero byte offset without reading neighboring bytes', () => {
    const backing = new Uint8Array(a.length + 13).fill(255);
    backing.set(a, 7);
    expect(encodeRte(decodeRte(backing.subarray(7, 7 + a.length)))).toEqual(a);
  });
  it('implements every reference elevation query without premature rounding', () => {
    const nodes = decodeRte(a).elev;
    expect(queryElevation(nodes, 7500)).toEqual({ hDm: 1050, upDm: 200, downDm: 150 });
    const start = queryElevation(nodes, 7500);
    const mid = queryElevation(nodes, 10000);
    const end = queryElevation(nodes, 20000);
    expect([10000 - 7500, mid.upDm - start.upDm, mid.downDm - start.downDm]).toEqual([
      2500, 0, 150,
    ]);
    expect([20000 - 7500, end.upDm - start.upDm, end.downDm - start.downDm]).toEqual([
      12500, 500, 150,
    ]);
    expect(end.hDm).toBe(1400);
    expect(queryElevation(nodes, 5001).hDm).toBeCloseTo(1199.94);
    expect(queryElevation(nodes, 0)).toEqual({ hDm: 1000, upDm: 0, downDm: 0 });
    expectError(() => queryElevation(nodes, 20001), 'range');
    expectError(() => queryElevation(nodes, -1), 'range');
    expectError(() => queryElevation(nodes, NaN), 'range');
    expect(decodeRte(b).elev).toEqual(nodes);
    expect(decodeRte(c).elev).toEqual(nodes);
    expectError(() => queryElevation([], 0), 'unavailable');
  });
});

describe('container validation even after CRC recomputation', () => {
  it('rejects a byte change without a matching checksum', () => {
    const bytes = a.slice();
    bytes[300] ^= 1;
    expectError(() => decodeRte(bytes));
  });
  it.each([
    [
      'magic',
      (bytes: Uint8Array) => {
        bytes[0] = 0;
      },
    ],
    ['header size', (_: Uint8Array, dv: DataView) => dv.setUint16(8, 65, true)],
    ['directory entry size', (_: Uint8Array, dv: DataView) => dv.setUint16(10, 25, true)],
    ['file size', (_: Uint8Array, dv: DataView) => dv.setUint32(12, 455, true)],
    ['directory offset', (_: Uint8Array, dv: DataView) => dv.setUint32(16, 68, true)],
    ['directory count', (_: Uint8Array, dv: DataView) => dv.setUint16(20, 2, true)],
    [
      'global flags',
      (bytes: Uint8Array) => {
        bytes[22] = 1;
      },
    ],
    ['zero identity', (bytes: Uint8Array) => bytes.fill(0, 24, 40)],
    ['zero revision', (_: Uint8Array, dv: DataView) => dv.setUint32(40, 0, true)],
    [
      'reserved header byte',
      (bytes: Uint8Array) => {
        bytes[48] = 1;
      },
    ],
    [
      'invalid FourCC',
      (bytes: Uint8Array) => {
        bytes[64] = 97;
      },
    ],
    ['undefined section flag', (_: Uint8Array, dv: DataView) => dv.setUint16(68, 3, true)],
    ['noncritical known section', (_: Uint8Array, dv: DataView) => dv.setUint16(68, 0, true)],
    ['empty section', (_: Uint8Array, dv: DataView) => dv.setUint32(76, 0, true)],
    ['overlap', (_: Uint8Array, dv: DataView) => dv.setUint32(96, 160, true)],
    ['out of file range', (_: Uint8Array, dv: DataView) => dv.setUint32(96, 0xfffffffc, true)],
    ['unmatched record fields', (_: Uint8Array, dv: DataView) => dv.setUint32(104, 0, true)],
    ['incorrect record size', (_: Uint8Array, dv: DataView) => dv.setUint32(104, 11, true)],
    [
      'record product overflow',
      (_: Uint8Array, dv: DataView) => {
        dv.setUint32(104, 0xffffffff, true);
        dv.setUint32(108, 0xffffffff, true);
      },
    ],
    [
      'nonzero padding',
      (bytes: Uint8Array) => {
        bytes[0x166] = 1;
      },
    ],
  ] as const)('rejects %s', (_, change) => expectError(() => decodeRte(mutate(change))));
  it('rejects every truncated header and directory prefix', () => {
    for (let length = 0; length < 160; length++) expectError(() => decodeRte(a.slice(0, length)));
  });
  it('rejects trailing bytes even when actual length and CRC are updated', () => {
    const bytes = new Uint8Array(a.length + 1);
    bytes.set(a);
    view(bytes).setUint32(12, bytes.length, true);
    expectError(() => decodeRte(fixCrc(bytes)));
  });
  it('rejects duplicate and missing sections', () => {
    const entries = sections(a);
    expectError(() => decodeRte(repack(a, [...entries, entries[0]])));
    expectError(() =>
      decodeRte(
        repack(
          a,
          entries.filter((entry) => entry.type !== 'GEOM'),
        ),
      ),
    );
    expectError(() =>
      decodeRte(
        repack(
          a,
          entries.filter((entry) => entry.type !== 'GIDX'),
        ),
      ),
    );
    expectError(() =>
      decodeRte(
        repack(
          a,
          entries.filter((entry) => entry.type !== 'META'),
        ),
      ),
    );
    expectError(() =>
      decodeRte(
        repack(
          a,
          entries.filter((entry) => entry.type !== 'ELEV'),
        ),
      ),
    );
  });
  it('accepts any section type order when offsets remain sorted', () => {
    const reordered = repack(a, sections(a).reverse());
    expect(decodeRte(reordered)).toEqual(decodeRte(a));
  });
  it('rejects GEOM, ELEV and GIDX sections below their minimum record counts', () => {
    for (const type of ['GEOM', 'ELEV', 'GIDX']) {
      const data = alterSection(type, (entry) => {
        entry.count = type === 'GIDX' ? 0 : 1;
        entry.bytes = entry.bytes.slice(0, entry.size * entry.count);
      });
      expectError(() => decodeRte(data));
    }
  });
});

describe('extension and version handling', () => {
  it('accepts a higher minor version and rejects another major version', () => {
    expect(decodeRte(mutate((_, dv) => dv.setUint16(6, 15, true))).name).toBe('Test');
    expectError(() => decodeRte(mutate((_, dv) => dv.setUint16(4, 2, true))), 'unsupported');
  });
  it('rejects an unsupported schema or known section version', () => {
    expectError(() => decodeRte(alterMeta((meta) => meta.set(0, 2))), 'unsupported');
    for (const type of ['META', 'GEOM', 'ELEV', 'GIDX']) {
      expectError(
        () =>
          decodeRte(
            alterSection(type, (entry) => {
              entry.version = 2;
            }),
          ),
        'unsupported',
      );
    }
  });
  it('skips a noncritical unknown section only after generic validation', () => {
    const entries = sections(a);
    const extension: TestSection = {
      type: 'TEST',
      flags: 0,
      version: 9,
      size: 0,
      count: 0,
      bytes: Uint8Array.of(5, 8, 13),
    };
    expect(decodeRte(repack(a, [...entries, extension]))).toEqual(decodeRte(a));
    expectError(
      () => decodeRte(repack(a, [...entries, { ...extension, flags: 1 }])),
      'unsupported',
    );
    expectError(() => decodeRte(repack(a, [...entries, { ...extension, size: 2, count: 2 }])));
    const encoded = repack(a, [...entries, extension]);
    encoded[encoded.length - 1] ^= 1;
    expectError(() => decodeRte(encoded));
  });
  it('ignores valid extension values, including low keys inside an extension map', () => {
    const extended = alterMeta((meta) => {
      meta.set(129, [
        null,
        false,
        true,
        -2147483648,
        4294967295,
        '',
        new Uint8Array(),
        new Map([[1, 'custom']]),
      ]);
      (meta.get(5) as Map<number, CborValue>).set(65535, 'details');
      meta.set(128, null);
    });
    expect(decodeRte(extended)).toEqual(decodeRte(a));
  });
  it('rejects reserved low keys in every defined map', () => {
    const selectors = [
      (m: Map<number, CborValue>) => m,
      (m: Map<number, CborValue>) => m.get(5) as Map<number, CborValue>,
      (m: Map<number, CborValue>) => m.get(9) as Map<number, CborValue>,
      (m: Map<number, CborValue>) => (m.get(7) as Map<number, CborValue>[])[0],
      (m: Map<number, CborValue>) => (m.get(8) as Map<number, CborValue>[])[0],
    ];
    for (const select of selectors)
      expectError(() => decodeRte(alterMeta((meta) => select(meta).set(127, null))));
    expectError(() => decodeRte(alterMeta((meta) => meta.set(6, new Map()))));
    expectError(() =>
      decodeRte(alterMeta((meta) => (meta.get(9) as Map<number, CborValue>).set(5, 0))),
    );
  });
  it('reports resource limits distinctly from invalid and unsupported input', () => {
    expectError(
      () => decodeRte(mutate((_, dv) => dv.setUint16(20, RTE_LIMITS.maxSections + 1, true))),
      'resource',
    );
    const deeplyNested = Uint8Array.from([...Array(CBOR_LIMITS.maxDepth + 1).fill(0x81), 0xf6]);
    expectError(() => decodeCbor(deeplyNested), 'resource');
    expectError(() => decodeCbor(Uint8Array.of(0x9a, 0, 1, 0x86, 0xa1)), 'resource');
  });
});

describe('restricted deterministic CBOR', () => {
  it.each([
    ['overlong integer', [0x18, 0x01]],
    ['overlong two-byte integer', [0x19, 0, 255]],
    ['overlong four-byte integer', [0x1a, 0, 0, 255, 255]],
    ['64-bit integer', [0x1b, 0, 0, 0, 1, 0, 0, 0, 0]],
    ['indefinite array', [0x9f, 0xff]],
    ['float', [0xfa, 0, 0, 0, 0]],
    ['undefined', [0xf7]],
    ['CBOR tag', [0xc0, 0]],
    ['negative map key', [0xa1, 0x20, 0]],
    ['text map key', [0xa1, 0x60, 0]],
    ['duplicate map key', [0xa2, 0, 0, 0, 1]],
    ['unordered map key', [0xa2, 1, 0, 0, 0]],
    ['out of range map key', [0xa1, 0x1a, 0, 1, 0, 0, 0]],
    ['too negative integer', [0x3a, 0x80, 0, 0, 0]],
    ['invalid UTF-8', [0x61, 255]],
    ['NUL', [0x61, 0]],
    ['trailing CBOR', [0xa0, 0]],
    ['overlong text length', [0x78, 1, 65]],
    ['truncated integer', [0x1a, 0, 0]],
    ['truncated string', [0x62, 65]],
  ] as const)('rejects %s', (_, encoded) =>
    expectError(() => decodeCbor(Uint8Array.from(encoded))),
  );
  it('checks the CBOR profile when reading META, not only through standalone helpers', () => {
    const encoded = alterSection('META', (entry) => {
      entry.bytes = Uint8Array.of(0xa1, 0x18, 0, 1);
    });
    expectError(() => decodeRte(encoded));
    expectError(() =>
      decodeRte(
        alterSection('META', (entry) => {
          entry.bytes = Uint8Array.of(0x80);
        }),
      ),
    );
  });
  it('preserves valid leading U+FEFF and supplementary Unicode characters', () => {
    expect(decodeCbor(encodeCbor('\ufeff路线🧭'))).toBe('\ufeff路线🧭');
  });
  it('rejects invalid strings and integers before generating bytes', () => {
    for (const value of [NaN, Infinity, 0.5, 4294967296, -2147483649, '\ud800', '\udc00', '\0']) {
      expectError(() => encodeCbor(value));
    }
    expectError(() => encodeCbor('x'.repeat(513)));
    expectError(() => encodeCbor(new Uint8Array(1025)));
    expectError(() => decodeCbor(Uint8Array.of(0x79, 2, 1))); // Text length 513.
    expectError(() => decodeCbor(Uint8Array.of(0x59, 4, 1))); // Byte-string length 1025.
  });
  it('writes numeric map keys in deterministic order', () => {
    expect([
      ...encodeCbor(
        new Map([
          [128, true],
          [1, false],
        ]),
      ),
    ]).toEqual([0xa2, 1, 0xf4, 0x18, 128, 0xf5]);
  });
});

describe('metadata and cross-section relationships', () => {
  it.each([
    [
      'fractional distance',
      (r: RouteData) => {
        r.totalSDm = 20000.5;
      },
    ],
    [
      'empty name',
      (r: RouteData) => {
        r.name = '';
      },
    ],
    [
      'name byte count',
      (r: RouteData) => {
        r.name = '路'.repeat(33);
      },
    ],
    [
      'name control character',
      (r: RouteData) => {
        r.name = 'Bad\nname';
      },
    ],
    [
      'station label byte count',
      (r: RouteData) => {
        r.stations[1].shortLabel = '站'.repeat(6);
      },
    ],
    [
      'route identity',
      (r: RouteData) => {
        r.routeId = new Uint8Array(16);
      },
    ],
    [
      'revision overflow',
      (r: RouteData) => {
        r.revision = 4294967296;
      },
    ],
    [
      'latitude range',
      (r: RouteData) => {
        r.geom[1].latE7 = 900000001;
      },
    ],
    [
      'positive 180 longitude',
      (r: RouteData) => {
        r.geom[1].lonE7 = 1800000000;
      },
    ],
    [
      'fractional longitude',
      (r: RouteData) => {
        r.geom[1].lonE7 = 1.5;
      },
    ],
    [
      'equal adjacent coordinates',
      (r: RouteData) => {
        r.geom[1].lonE7 = r.geom[0].lonE7;
      },
    ],
    [
      'non-increasing geometry',
      (r: RouteData) => {
        r.geom[1].sDm = 0;
      },
    ],
    [
      'incorrect geometry endpoint',
      (r: RouteData) => {
        r.geom[2].sDm = 19999;
      },
    ],
    [
      'non-increasing elevation',
      (r: RouteData) => {
        r.elev[1].sDm = 0;
      },
    ],
    [
      'incomplete elevation',
      (r: RouteData) => {
        r.elev[3].sDm = 19999;
      },
    ],
    [
      'elevation sentinel NaN',
      (r: RouteData) => {
        r.elev[1].hDm = NaN;
      },
    ],
    [
      'nonzero initial ascent',
      (r: RouteData) => {
        r.elev[0].upDm = 1;
      },
    ],
    [
      'incorrect cumulative ascent',
      (r: RouteData) => {
        r.elev[2].upDm = 201;
      },
    ],
    [
      'incorrect cumulative descent',
      (r: RouteData) => {
        r.elev[2].downDm = 301;
      },
    ],
    [
      'missing elevation metadata',
      (r: RouteData) => {
        Reflect.deleteProperty(r, 'elevationInfo');
      },
    ],
    [
      'missing elevation section',
      (r: RouteData) => {
        Reflect.deleteProperty(r, 'elev');
      },
    ],
    [
      'duplicate station ID',
      (r: RouteData) => {
        r.stations[1].eventId = 1;
      },
    ],
    [
      'duplicate start',
      (r: RouteData) => {
        r.stations[1].kind = 0;
      },
    ],
    [
      'missing finish',
      (r: RouteData) => {
        r.stations[2].kind = 2;
      },
    ],
    [
      'start not boundary',
      (r: RouteData) => {
        r.stations[0].stageBoundary = false;
      },
    ],
    [
      'incorrect station order',
      (r: RouteData) => {
        r.stations.reverse();
      },
    ],
    [
      'missing boundary geometry node',
      (r: RouteData) => {
        r.geom[1].sDm = 10001;
      },
    ],
    [
      'missing boundary elevation node',
      (r: RouteData) => {
        r.elev[2].sDm = 10001;
      },
    ],
    [
      'duplicate boundary distances',
      (r: RouteData) => {
        r.stations[1].sDm = 0;
      },
    ],
    [
      'missing stage summaries',
      (r: RouteData) => {
        Reflect.deleteProperty(r, 'stages');
      },
    ],
    [
      'undefined stage summaries',
      (r: RouteData) => {
        Reflect.set(r, 'stages', undefined);
      },
    ],
    [
      'empty stage summaries',
      (r: RouteData) => {
        r.stages = [];
      },
    ],
    [
      'partial stage summaries',
      (r: RouteData) => {
        r.stages.pop();
      },
    ],
    [
      'incorrect stage pair',
      (r: RouteData) => {
        r.stages[0].toEventId = 3;
      },
    ],
    [
      'incorrect stage minimum',
      (r: RouteData) => {
        r.stages[0].minHDm = 901;
      },
    ],
    [
      'missing stage maximum',
      (r: RouteData) => {
        Reflect.deleteProperty(r.stages[0], 'maxHDm');
      },
    ],
    [
      'missing stage minimum',
      (r: RouteData) => {
        Reflect.deleteProperty(r.stages[0], 'minHDm');
      },
    ],
    [
      'missing complete elevation',
      (r: RouteData) => {
        Reflect.deleteProperty(r, 'elev');
        Reflect.deleteProperty(r, 'elevationInfo');
      },
    ],
  ] as const)('refuses to encode %s', (_, change) => {
    const route = decodeRte(a);
    change(route);
    expectError(() => encodeRte(route));
  });
  it('accepts valid zero and negative elevations', () => {
    const route = decodeRte(a);
    for (const node of route.elev) node.hDm -= 1200;
    for (const stage of route.stages) {
      stage.minHDm -= 1200;
      stage.maxHDm -= 1200;
    }
    expect(decodeRte(encodeRte(route)).elev[1].hDm).toBe(0);
    expect(queryElevation(route.elev, 0).hDm).toBe(-200);
  });
  it('retains non-boundary events at equal distances in numeric event-ID order', () => {
    const route = decodeRte(a);
    route.stations.splice(2, 0, { ...route.stations[1], eventId: 4, stageBoundary: false });
    validateRoute(route);
    expect(decodeRte(encodeRte(route)).stations).toHaveLength(4);
    route.stations[2].eventId = 1;
    expectError(() => encodeRte(route));
  });
  it('rejects metadata type violations and missing required fields after a fresh CRC', () => {
    for (const key of [0, 1, 2, 3, 4, 5, 7, 8])
      expectError(() => decodeRte(alterMeta((meta) => meta.delete(key))));
    expectError(() => decodeRte(alterMeta((meta) => meta.set(2, '20000'))));
    expectError(() => decodeRte(alterMeta((meta) => meta.set(7, []))));
    expectError(() =>
      decodeRte(alterMeta((meta) => (meta.get(5) as Map<number, CborValue>).set(5, 0))),
    );
    expectError(() =>
      decodeRte(
        alterSection('ELEV', (entry) => {
          view(entry.bytes).setUint32(40, 201, true);
        }),
      ),
    );
    expectError(() =>
      decodeRte(
        alterSection('GEOM', (entry) => {
          view(entry.bytes).setInt32(12, 900000001, true);
        }),
      ),
    );
  });
});

describe('required stage summaries', () => {
  it.each([
    ['b', 464, 9, 0x73cfbd2c, '956eda7c0a704f0b0651632a02ff6cce754920758b7d201c92196875a29e6478'],
    ['c', 404, 10, 0xbb625a01, '2362b1a26f6d82bd399c5e0436544642f3cd1db941332842cd2843b5e10abf5d'],
  ] as const)(
    'rejects the unchanged legacy vector %s without summaries',
    (name, size, revision, crc, sha256) => {
      const bytes = loadVector(`legacy/2026-10-17-vector-${name}.hex`);
      expect(bytes.length).toBe(size);
      expect(view(bytes).getUint32(40, true)).toBe(revision);
      expect(view(bytes).getUint32(44, true)).toBe(crc);
      expect(crc32(bytes, true)).toBe(crc);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
      expect(() => decodeRte(bytes)).toThrow(
        expect.objectContaining({
          code: 'invalid',
          message: 'Stages must contain 1..4095 entries.',
        }),
      );
    },
  );

  it.each([null, false, 1, 'stages', new Map(), [], Array(4096).fill(null)] as CborValue[])(
    'rejects malformed summary arrays after CRC recomputation (%#)',
    (value) => {
      expectError(() => decodeRte(alterMeta((meta) => meta.set(8, value))));
    },
  );

  it.each([
    ['partial summaries', (stages: Map<number, CborValue>[]) => stages.pop()],
    ['extra summaries', (stages: Map<number, CborValue>[]) => stages.push(stages[0])],
    ['reversed summaries', (stages: Map<number, CborValue>[]) => stages.reverse()],
    ['incorrect from event', (stages: Map<number, CborValue>[]) => stages[0].set(0, 2)],
    ['incorrect to event', (stages: Map<number, CborValue>[]) => stages[0].set(1, 3)],
    ['missing minimum', (stages: Map<number, CborValue>[]) => stages[0].delete(2)],
    ['missing maximum', (stages: Map<number, CborValue>[]) => stages[0].delete(3)],
    ['incorrect minimum', (stages: Map<number, CborValue>[]) => stages[0].set(2, 901)],
    ['incorrect maximum', (stages: Map<number, CborValue>[]) => stages[0].set(3, 1199)],
  ] as const)('rejects %s after CRC recomputation', (_, change) => {
    expectError(() =>
      decodeRte(alterMeta((meta) => change(meta.get(8) as Map<number, CborValue>[]))),
    );
  });

  it('accepts exactly one summary when only the endpoints are stage boundaries', () => {
    const route = decodeRte(a);
    route.stations[1].stageBoundary = false;
    route.stages = [{ fromEventId: 1, toEventId: 3, minHDm: 900, maxHDm: 1400 }];
    expect(decodeRte(encodeRte(route))).toEqual(route);
  });
});

describe('geometry index', () => {
  it('rejects a bad block start, count, distance, or bound after CRC recomputation', () => {
    for (const offset of [0, 4, 8, 12, 16, 20, 24, 28]) {
      const changed = alterSection('GIDX', (entry) => {
        const dv = view(entry.bytes);
        dv.setInt32(offset, dv.getInt32(offset, true) + 1, true);
      });
      expectError(() => decodeRte(changed));
    }
  });
  it('indexes antimeridian crossings using the full longitude range', () => {
    const route = decodeRte(b);
    route.geom[0].lonE7 = 1790000000;
    route.geom[1].lonE7 = -1790000000;
    route.geom[2].lonE7 = -1780000000;
    const encoded = encodeRte(route);
    expect(decodeRte(encoded).geom).toEqual(route.geom);
    const index = sections(encoded).find((entry) => entry.type === 'GIDX')!;
    expect(view(index.bytes).getInt32(24, true)).toBe(-1800000000);
    expect(view(index.bytes).getInt32(28, true)).toBe(1800000000);
    const changed = alterSection(
      'GIDX',
      (entry) => {
        view(entry.bytes).setInt32(28, 1790000000, true);
      },
      encoded,
    );
    expectError(() => decodeRte(changed));
  });
  it('covers each segment exactly once across blocks and permits alternative valid partitions', () => {
    const route = decodeRte(b);
    route.geom = Array.from({ length: 258 }, (_, i) => ({
      latE7: 0,
      lonE7: i * 1000,
      sDm: i * 100,
    }));
    route.totalSDm = 25700;
    route.elev = [
      { sDm: 0, hDm: 0, upDm: 0, downDm: 0 },
      { sDm: 25700, hDm: 0, upDm: 0, downDm: 0 },
    ];
    route.stations = [route.stations[0], { ...route.stations[2], sDm: 25700 }];
    route.stages = [{ fromEventId: 1, toEventId: 3, minHDm: 0, maxHDm: 0 }];
    const encoded = encodeRte(route);
    expect(decodeRte(encoded).geom).toHaveLength(258);
    const index = sections(encoded).find((entry) => entry.type === 'GIDX')!;
    expect(index.count).toBe(3);
    expect([0, 32, 64].map((offset) => view(index.bytes).getUint32(offset, true))).toEqual([
      0, 128, 256,
    ]);
    expectError(() =>
      decodeRte(
        alterSection(
          'GIDX',
          (entry) => {
            view(entry.bytes).setUint32(32, 127, true);
          },
          encoded,
        ),
      ),
    );
    expectError(() =>
      decodeRte(
        alterSection(
          'GIDX',
          (entry) => {
            entry.count = 2;
            entry.bytes = entry.bytes.slice(0, 64);
          },
          encoded,
        ),
      ),
    );
    // The format allows blocks shorter than 128 segments; vector A has two segments.
    const alternative = alterSection('GIDX', (entry) => {
      entry.count = 2;
      entry.bytes = new Uint8Array(64);
      const dv = view(entry.bytes);
      const geom = decodeRte(a).geom;
      for (let i = 0; i < 2; i++) {
        const p = i * 32;
        [i, 2, geom[i].sDm, geom[i + 1].sDm, 0, 0, geom[i].lonE7, geom[i + 1].lonE7].forEach(
          (n, j) => dv.setInt32(p + j * 4, n, true),
        );
      }
    });
    expect(decodeRte(alternative)).toEqual(decodeRte(a));
  });
});

describe('magnetic declination metadata and heading queries', () => {
  it('implements vector A/B headings and inclusive applicability dates', () => {
    for (const bytes of [a, b]) {
      const info = decodeRte(bytes).magneticDeclination!;
      expect(info).toEqual({
        declinationCdeg: -350,
        referenceLatE7: 0,
        referenceLonE7: 89832,
        referenceDate: '2026-10-16',
        source: 'synthetic',
        validFrom: '2026-10-16',
        validUntil: '2027-10-15',
      });
      expect(convertHeading(200, info, '2026-10-16', 'true')).toBe(35850);
      expect(convertHeading(35850, info, '2027-10-15', 'magnetic')).toBe(200);
      expect(queryMagneticDeclination(info, '2026-10-16')).toEqual({
        declinationCdeg: -350,
        applicability: 'applicable',
      });
      for (const date of ['2026-10-15', '2027-10-16']) {
        expect(() => queryMagneticDeclination(info, date)).toThrow(
          expect.objectContaining({ code: 'unavailable', applicability: 'outside_interval' }),
        );
      }
      expect(() => queryMagneticDeclination(info)).toThrow(
        expect.objectContaining({ code: 'unavailable', applicability: 'time_unknown' }),
      );
      expectError(() => convertHeading(200, info, undefined, 'true'), 'unavailable');
    }
    for (const date of [undefined, '2026-10-16']) {
      expect(() => queryMagneticDeclination(decodeRte(c).magneticDeclination, date)).toThrow(
        expect.objectContaining({ code: 'unavailable', applicability: 'unavailable' }),
      );
    }
  });
  it('preserves zero, absent optional fields and unspecified applicability with or without a trusted date', () => {
    const route = decodeRte(c);
    route.magneticDeclination = {
      declinationCdeg: 0,
      referenceLatE7: -900000000,
      referenceLonE7: -1800000000,
      referenceDate: '0001-01-01',
      source: 'observation',
    };
    const info = decodeRte(encodeRte(route)).magneticDeclination!;
    expect(info).toEqual(route.magneticDeclination);
    for (const date of [undefined, '9999-12-31']) {
      expect(queryMagneticDeclination(info, date)).toEqual({
        declinationCdeg: 0,
        applicability: 'unspecified',
      });
    }
    expect(convertHeading(-1, info, undefined, 'true')).toBe(35999);
    expect(convertHeading(72000, info, '2026-10-16', 'magnetic')).toBe(0);
  });
  it.each([
    [0, -18001],
    [0, 18001],
    [0, '0'],
    [0, 1.5],
    [1, 900000001],
    [2, 1800000000],
    [3, '0000-01-01'],
    [3, '1900-02-29'],
    [3, '2026-02-29'],
    [3, '2026-04-31'],
    [3, '2026-00-01'],
    [3, '2026-13-01'],
    [3, '2026-01-00'],
    [3, '2026-1-01'],
    [4, ''],
    [4, '路'.repeat(22)],
    [5, 0],
    [6, '2026-10-17'],
    [7, '2026-10-15'],
    [7, '2027-02-29'],
    [127, null],
  ] as [number, CborValue][])(
    'rejects malformed declination key %s = %s with a valid CRC',
    (key, value) => {
      expectError(() =>
        decodeRte(alterMeta((meta) => (meta.get(9) as Map<number, CborValue>).set(key, value))),
      );
    },
  );
  it('requires all mandatory fields and paired validity dates, and a map at root key 9', () => {
    for (const key of [0, 1, 2, 3, 4, 6, 7]) {
      expectError(() =>
        decodeRte(alterMeta((meta) => (meta.get(9) as Map<number, CborValue>).delete(key))),
      );
    }
    expectError(() => decodeRte(alterMeta((meta) => meta.set(9, null))));
  });
  it('ignores arbitrary valid extension key 128 even when it resembles obsolete declination metadata', () => {
    for (const value of [
      null,
      'safe to ignore',
      new Map<number, CborValue>([
        [5, 123],
        [127, false],
      ]),
    ] as CborValue[]) {
      const extended = alterMeta((meta) => meta.set(128, value));
      expect(decodeRte(extended)).toEqual(decodeRte(a));
    }
    const extensionOnly = alterMeta((meta) => {
      meta.set(128, meta.get(9)!);
      meta.delete(9);
    });
    expect(decodeRte(extensionOnly).magneticDeclination).toBeUndefined();
  });
  it('validates dates and ranges before encoding and accepts Gregorian leap years and range endpoints', () => {
    const route = decodeRte(a);
    route.magneticDeclination!.declinationCdeg = NaN;
    expectError(() => encodeRte(route));
    for (const date of ['2000-02-29', '2028-02-29', '0096-02-29', '9999-12-31']) {
      route.magneticDeclination = {
        ...decodeRte(a).magneticDeclination!,
        declinationCdeg: 18000,
        referenceLatE7: 900000000,
        referenceLonE7: 1799999999,
        referenceDate: date,
        validFrom: date,
        validUntil: date,
      };
      expect(decodeRte(encodeRte(route)).magneticDeclination).toEqual(route.magneticDeclination);
    }
    expectError(() => queryMagneticDeclination(route.magneticDeclination, '2026-02-29'));
    expectError(
      () => convertHeading(NaN, route.magneticDeclination, '9999-12-31', 'true'),
      'range',
    );
    const extended = alterMeta((meta) =>
      (meta.get(9) as Map<number, CborValue>).set(128, new Map([[0, 'custom']])),
    );
    expect(decodeRte(extended)).toEqual(decodeRte(a));
  });
});

describe('reference geometry interpolation', () => {
  it.each([
    [20, 28, 24],
    [179.999, -179.999, -180],
    [-179.999, 179.999, -180],
    [-170, 10, -80],
    [10, -170, -80],
  ])('interpolates midpoint longitude from %s° to %s° as %s°', (start, end, expected) => {
    const nodes = [
      { latE7: 0, lonE7: Math.round(start * 1e7), sDm: 0 },
      { latE7: 10000000, lonE7: Math.round(end * 1e7), sDm: 100 },
    ];
    expect(queryGeometry(nodes, 50)).toEqual({ lat: 0.5, lon: expected });
    expect(queryGeometry(nodes, 0)).toEqual({ lat: 0, lon: start });
    expect(queryGeometry(nodes, 100)).toEqual({ lat: 1, lon: end });
  });
  it('retains precision between nodes and rejects out-of-range queries', () => {
    const nodes = decodeRte(a).geom;
    expect(queryGeometry(nodes, 1).lon).toBeCloseTo(0.00000089832);
    for (const s of [-1, 20001, NaN, Infinity]) expectError(() => queryGeometry(nodes, s), 'range');
    expectError(() => queryGeometry([], 0), 'unavailable');
  });
});

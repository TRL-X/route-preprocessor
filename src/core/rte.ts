import { CBOR_LIMITS, decodeCbor, encodeCbor, invalid, resource, RteError, textBytes } from './cbor';
import type { CborValue } from './cbor';
import type { ElevationInfo, ElevNode, GeomNode, PreprocessingInfo, ProfileValue, RouteData, Stage, StationEvent } from './types';

export { RteError } from './cbor';

/** Implementation budgets, not format limits. Exceeding these is a resource error. */
export const RTE_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxSections: 256,
  maxGeometryNodes: 1_000_000,
  maxElevationNodes: 1_000_000,
  maxIndexRecords: 1_000_000,
  cbor: CBOR_LIMITS,
});

const U32 = 0xffffffff;
const I32_MIN = -0x80000000;
const I32_MAX = 0x7fffffff;
const LAT = 900_000_000;
const LON = 1_800_000_000;
const align4 = (n: number) => Math.ceil(n / 4) * 4;
const map = (entries: [number, CborValue][]) => new Map<number, CborValue>(entries);

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${label} must be an integer in ${min}..${max}.`);
  }
  return value;
}

function string(value: unknown, maxBytes: number, label: string, name = false): string {
  if (typeof value !== 'string') invalid(`${label} must be text.`);
  const bytes = textBytes(value);
  if (bytes.length < 1 || bytes.length > maxBytes) invalid(`${label} must contain 1..${maxBytes} UTF-8 bytes.`);
  if (name && /[\u0001-\u001f\u007f]/u.test(value)) invalid(`${label} contains a prohibited control character.`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean.`);
  return value;
}

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`);
}

function array(value: unknown, min: number, max: number, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(`${label} must contain ${min}..${max} entries.`);
}

function structured(value: CborValue | undefined, known: number[], label: string): Map<number, CborValue> {
  if (!(value instanceof Map)) invalid(`${label} must be a CBOR map.`);
  for (const key of value.keys()) {
    if (key < 128 && !known.includes(key)) invalid(`${label} uses reserved key ${key}.`);
  }
  return value;
}

function decodeMeta(value: CborValue): Omit<RouteData, 'routeId' | 'revision' | 'geom' | 'elev'> {
  const root = structured(value, [0, 1, 2, 3, 4, 5, 6, 7, 8], 'META');
  const schema = integer(root.get(0), 0, U32, 'META.schema_version');
  if (schema !== 1) throw new RteError('unsupported', `Unsupported META schema ${schema}.`);
  if (integer(root.get(4), 0, U32, 'META.coordinate_ref') !== 1) invalid('META.coordinate_ref must be WGS84 E7 (1).');
  const name = string(root.get(1), 96, 'Route name', true);
  const totalSDm = integer(root.get(2), 1, U32, 'META.total_s_dm');
  const routeKind = integer(root.get(3), 0, 1, 'META.route_kind') as 0 | 1;
  let elevationInfo: ElevationInfo | undefined;
  if (root.has(5)) {
    const info = structured(root.get(5), [0, 1, 2, 3, 4, 5], 'META.elevation');
    elevationInfo = {
      source: integer(info.get(0), 0, 4, 'Elevation source') as ElevationInfo['source'],
      verticalDatum: integer(info.get(1), 0, 3, 'Vertical datum') as ElevationInfo['verticalDatum'],
      quality: integer(info.get(2), 0, 2, 'Elevation quality') as ElevationInfo['quality'],
    };
    if (info.has(3)) elevationInfo.sourceDetail = string(info.get(3), 128, 'Elevation source detail');
    if (info.has(4)) elevationInfo.datumName = string(info.get(4), 64, 'Elevation datum name');
    if (info.has(5)) elevationInfo.containsFilledValues = boolean(info.get(5), 'Elevation contains filled values');
  }
  const prep = structured(root.get(6), [0, 1, 2, 3, 4], 'META.preprocessing');
  const preprocessing: PreprocessingInfo = {
    tool: string(prep.get(0), 64, 'Preprocessing tool'),
    toolVersion: string(prep.get(1), 32, 'Preprocessing tool version'),
    recipeId: string(prep.get(2), 64, 'Preprocessing recipe'),
  };
  if (prep.has(3)) {
    const hash = prep.get(3);
    if (!(hash instanceof Uint8Array) || hash.length !== 32) invalid('Input SHA-256 must be exactly 32 bytes.');
    preprocessing.inputSha256 = hash;
  }
  if (prep.has(4)) {
    const params = structured(prep.get(4), [0, 1, 2], 'Preprocessing parameters');
    preprocessing.parameters = {};
    if (params.has(0)) preprocessing.parameters.geometryToleranceDm = integer(params.get(0), 0, U32, 'Geometry tolerance');
    if (params.has(1)) preprocessing.parameters.elevationGridDm = integer(params.get(1), 1, U32, 'Elevation grid');
    if (params.has(2)) preprocessing.parameters.elevationSmoothingWindowDm = integer(params.get(2), 0, U32, 'Elevation smoothing window');
  }
  const stationValues = root.get(7);
  array(stationValues, 2, 4096, 'Stations');
  const stations: StationEvent[] = stationValues.map((value, i) => {
    const entry = structured(value as CborValue, [0, 1, 2, 3, 4, 5, 6, 7], `Station ${i}`);
    return {
      eventId: integer(entry.get(0), 1, U32, 'Station event ID'),
      name: string(entry.get(1), 96, 'Station name', true),
      shortLabel: string(entry.get(2), 16, 'Station short label', true),
      kind: integer(entry.get(3), 0, 4, 'Station kind') as StationEvent['kind'],
      stageBoundary: boolean(entry.get(4), 'Station stage boundary'),
      sDm: integer(entry.get(5), 0, totalSDm, 'Station distance'),
      actualLatE7: integer(entry.get(6), -LAT, LAT, 'Station latitude'),
      actualLonE7: integer(entry.get(7), -LON, LON - 1, 'Station longitude'),
    };
  });
  let stages: Stage[] | undefined;
  if (root.has(8)) {
    const stageValues = root.get(8);
    array(stageValues, 1, 4095, 'Stages');
    stages = stageValues.map((value, i) => {
      const entry = structured(value as CborValue, [0, 1, 2, 3], `Stage ${i}`);
      const stage: Stage = {
        fromEventId: integer(entry.get(0), 1, U32, 'Stage from event ID'),
        toEventId: integer(entry.get(1), 1, U32, 'Stage to event ID'),
      };
      if (entry.has(2)) stage.minHDm = integer(entry.get(2), I32_MIN, I32_MAX, 'Stage minimum elevation');
      if (entry.has(3)) stage.maxHDm = integer(entry.get(3), I32_MIN, I32_MAX, 'Stage maximum elevation');
      return stage;
    });
  }
  return { name, totalSDm, routeKind, preprocessing, stations, ...(elevationInfo ? { elevationInfo } : {}), ...(stages ? { stages } : {}) };
}

function toMeta(route: RouteData): Map<number, CborValue> {
  object(route, 'Route');
  object(route.preprocessing, 'Preprocessing');
  const prep = route.preprocessing;
  const preprocessing = map([[0, prep.tool], [1, prep.toolVersion], [2, prep.recipeId]]);
  if (prep.inputSha256 !== undefined) preprocessing.set(3, prep.inputSha256);
  if (prep.parameters !== undefined) {
    object(prep.parameters, 'Preprocessing parameters');
    const p = prep.parameters;
    const parameters = new Map<number, CborValue>();
    if (p.geometryToleranceDm !== undefined) parameters.set(0, p.geometryToleranceDm);
    if (p.elevationGridDm !== undefined) parameters.set(1, p.elevationGridDm);
    if (p.elevationSmoothingWindowDm !== undefined) parameters.set(2, p.elevationSmoothingWindowDm);
    preprocessing.set(4, parameters);
  }
  array(route.stations, 2, 4096, 'Stations');
  const stations = route.stations.map(station => {
    object(station, 'Station');
    return map([[0, station.eventId], [1, station.name], [2, station.shortLabel], [3, station.kind],
      [4, station.stageBoundary], [5, station.sDm], [6, station.actualLatE7], [7, station.actualLonE7]]);
  });
  const meta = map([[0, 1], [1, route.name], [2, route.totalSDm], [3, route.routeKind], [4, 1], [6, preprocessing], [7, stations]]);
  if (route.elevationInfo !== undefined) {
    object(route.elevationInfo, 'Elevation info');
    const e = route.elevationInfo;
    const elevation = map([[0, e.source], [1, e.verticalDatum], [2, e.quality]]);
    if (e.sourceDetail !== undefined) elevation.set(3, e.sourceDetail);
    if (e.datumName !== undefined) elevation.set(4, e.datumName);
    if (e.containsFilledValues !== undefined) elevation.set(5, e.containsFilledValues);
    meta.set(5, elevation);
  }
  if (route.stages !== undefined) {
    array(route.stages, 1, 4095, 'Stages');
    meta.set(8, route.stages.map(stage => {
      object(stage, 'Stage');
      const result = map([[0, stage.fromEventId], [1, stage.toEventId]]);
      if (stage.minHDm !== undefined) result.set(2, stage.minHDm);
      if (stage.maxHDm !== undefined) result.set(3, stage.maxHDm);
      return result;
    }));
  }
  return meta;
}

/** Validates the internal encoded-unit model without modifying or silently fixing it. */
export function validateRoute(route: RouteData): void {
  // Reuse exactly the same schema validator as the binary reader.
  decodeMeta(toMeta(route));
  if (!(route.routeId instanceof Uint8Array) || route.routeId.length !== 16 || !route.routeId.some(n => n !== 0)) {
    invalid('Route ID must contain 16 bytes and must not be all zero.');
  }
  integer(route.revision, 1, U32, 'Revision');
  if (!Array.isArray(route.geom) || route.geom.length < 2) invalid('GEOM requires at least two nodes.');
  if (route.geom.length > RTE_LIMITS.maxGeometryNodes) resource('GEOM exceeds the node limit.');
  const geometryDistances = new Set<number>();
  for (let i = 0; i < route.geom.length; i++) {
    const node = route.geom[i];
    object(node, 'GEOM node');
    integer(node.latE7, -LAT, LAT, 'GEOM latitude');
    integer(node.lonE7, -LON, LON - 1, 'GEOM longitude');
    integer(node.sDm, 0, route.totalSDm, 'GEOM distance');
    if (i > 0) {
      const previous = route.geom[i - 1];
      if (node.sDm <= previous.sDm) invalid('GEOM distances must strictly increase.');
      if (node.latE7 === previous.latE7 && node.lonE7 === previous.lonE7) invalid('Adjacent GEOM nodes must have distinct coordinates.');
    }
    geometryDistances.add(node.sDm);
  }
  if (route.geom[0].sDm !== 0 || route.geom[route.geom.length - 1].sDm !== route.totalSDm) invalid('GEOM endpoints must be 0 and S.');
  if ((route.elev !== undefined) !== (route.elevationInfo !== undefined)) invalid('ELEV and META.elevation must be present together.');
  let elevationDistances: Set<number> | undefined;
  if (route.elev !== undefined) {
    if (!Array.isArray(route.elev) || route.elev.length < 2) invalid('ELEV requires at least two nodes.');
    if (route.elev.length > RTE_LIMITS.maxElevationNodes) resource('ELEV exceeds the node limit.');
    elevationDistances = new Set<number>();
    for (let i = 0; i < route.elev.length; i++) {
      const node = route.elev[i];
      object(node, 'ELEV node');
      integer(node.sDm, 0, route.totalSDm, 'ELEV distance');
      integer(node.hDm, I32_MIN, I32_MAX, 'ELEV height');
      integer(node.upDm, 0, U32, 'ELEV ascent');
      integer(node.downDm, 0, U32, 'ELEV descent');
      if (i === 0) {
        if (node.sDm !== 0 || node.upDm !== 0 || node.downDm !== 0) invalid('ELEV must start at 0 with zero ascent and descent.');
      } else {
        const previous = route.elev[i - 1];
        if (node.sDm <= previous.sDm) invalid('ELEV distances must strictly increase.');
        const delta = node.hDm - previous.hDm;
        if (node.upDm !== previous.upDm + Math.max(delta, 0) || node.downDm !== previous.downDm + Math.max(-delta, 0)) {
          invalid('ELEV cumulative ascent/descent equations do not hold.');
        }
      }
      elevationDistances.add(node.sDm);
    }
    if (route.elev[route.elev.length - 1].sDm !== route.totalSDm) invalid('ELEV must end at S.');
  }
  const ids = new Set<number>();
  const boundaries: StationEvent[] = [];
  let starts = 0;
  let finishes = 0;
  for (let i = 0; i < route.stations.length; i++) {
    const event = route.stations[i];
    if (ids.has(event.eventId)) invalid('Station event IDs must be unique.');
    ids.add(event.eventId);
    if (event.kind === 0) starts++;
    if (event.kind === 1) finishes++;
    if (i > 0) {
      const previous = route.stations[i - 1];
      if (event.sDm < previous.sDm || (event.sDm === previous.sDm && event.eventId <= previous.eventId)) {
        invalid('Stations must be sorted by (s_dm, event_id).');
      }
    }
    if (event.stageBoundary) {
      if (boundaries.length && event.sDm <= boundaries[boundaries.length - 1].sDm) invalid('Stage boundary distances must strictly increase.');
      if (!geometryDistances.has(event.sDm) || (elevationDistances && !elevationDistances.has(event.sDm))) {
        invalid('Stage boundaries must match exact GEOM and ELEV nodes.');
      }
      boundaries.push(event);
    }
  }
  const first = route.stations[0];
  const last = route.stations[route.stations.length - 1];
  if (starts !== 1 || finishes !== 1 || first.kind !== 0 || last.kind !== 1 ||
    first.sDm !== 0 || last.sDm !== route.totalSDm || !first.stageBoundary || !last.stageBoundary) {
    invalid('Exactly one start and finish must be first and last, at 0 and S, and both stage boundaries.');
  }
  if (route.stages) {
    if (route.stages.length !== boundaries.length - 1) invalid('Stage cache must cover every consecutive boundary pair.');
    let elevationIndex = 0;
    for (let i = 0; i < route.stages.length; i++) {
      const stage = route.stages[i];
      if (stage.fromEventId !== boundaries[i].eventId || stage.toEventId !== boundaries[i + 1].eventId) {
        invalid('Stage cache has an incorrect boundary pair or order.');
      }
      if (route.elev) {
        let minimum = Infinity;
        let maximum = -Infinity;
        // Inclusive intervals share their endpoint; each sample is visited at most twice.
        while (route.elev[elevationIndex].sDm < boundaries[i].sDm) elevationIndex++;
        while (elevationIndex < route.elev.length && route.elev[elevationIndex].sDm <= boundaries[i + 1].sDm) {
          const node = route.elev[elevationIndex];
          minimum = Math.min(minimum, node.hDm);
          maximum = Math.max(maximum, node.hDm);
          elevationIndex++;
        }
        elevationIndex--;
        if (stage.minHDm !== minimum || stage.maxHDm !== maximum) invalid('Stage cached elevation extrema are incorrect or missing.');
      } else if (stage.minHDm !== undefined || stage.maxHDm !== undefined) invalid('Stage elevation extrema must be absent without ELEV.');
    }
  }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** Generic IEEE CRC32; pass true for the RTE checksum with bytes 44..47 zeroed. */
export function crc32(bytes: Uint8Array, zeroRteChecksum = false): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const byte = zeroRteChecksum && i >= 44 && i < 48 ? 0 : bytes[i];
    c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface IndexRecord {
  first: number; count: number; sBegin: number; sEnd: number;
  minLat: number; maxLat: number; minLon: number; maxLon: number;
}

function indexBlock(geom: GeomNode[], first: number, count: number): IndexRecord {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let wraps = false;
  for (let i = first; i < first + count; i++) {
    const node = geom[i];
    minLat = Math.min(minLat, node.latE7);
    maxLat = Math.max(maxLat, node.latE7);
    minLon = Math.min(minLon, node.lonE7);
    maxLon = Math.max(maxLon, node.lonE7);
    if (i > first && Math.abs(node.lonE7 - geom[i - 1].lonE7) > LON) wraps = true;
  }
  return { first, count, sBegin: geom[first].sDm, sEnd: geom[first + count - 1].sDm,
    minLat, maxLat, minLon: wraps ? -LON : minLon, maxLon: wraps ? LON : maxLon };
}

interface Section { type: string; bytes: Uint8Array; size: number; count: number }

function recordSection(type: string, size: number, count: number, write: (view: DataView, index: number, offset: number) => void): Section {
  const bytes = new Uint8Array(size * count);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) write(view, i, i * size);
  return { type, bytes, size, count };
}

/**
 * Emits the canonical producer layout. Callers own route identity: any content or
 * serialization change, including canonicalizing a foreign file, needs a new revision.
 */
export function encodeRte(route: RouteData): Uint8Array {
  validateRoute(route);
  const sections: Section[] = [{ type: 'META', bytes: encodeCbor(toMeta(route)), size: 0, count: 0 }];
  sections.push(recordSection('GEOM', 12, route.geom.length, (view, i, offset) => {
    const n = route.geom[i];
    view.setInt32(offset, n.latE7, true);
    view.setInt32(offset + 4, n.lonE7, true);
    view.setUint32(offset + 8, n.sDm, true);
  }));
  if (route.elev) {
    const elev = route.elev;
    sections.push(recordSection('ELEV', 16, elev.length, (view, i, offset) => {
      const n = elev[i];
      view.setUint32(offset, n.sDm, true);
      view.setInt32(offset + 4, n.hDm, true);
      view.setUint32(offset + 8, n.upDm, true);
      view.setUint32(offset + 12, n.downDm, true);
    }));
  }
  const indexCount = Math.ceil((route.geom.length - 1) / 128);
  sections.push(recordSection('GIDX', 32, indexCount, (view, i, offset) => {
    const first = i * 128;
    const b = indexBlock(route.geom, first, Math.min(129, route.geom.length - first));
    view.setUint32(offset, b.first, true);
    view.setUint32(offset + 4, b.count, true);
    view.setUint32(offset + 8, b.sBegin, true);
    view.setUint32(offset + 12, b.sEnd, true);
    view.setInt32(offset + 16, b.minLat, true);
    view.setInt32(offset + 20, b.maxLat, true);
    view.setInt32(offset + 24, b.minLon, true);
    view.setInt32(offset + 28, b.maxLon, true);
  }));
  let length = 64 + 24 * sections.length;
  for (const section of sections) length = align4(length) + section.bytes.length;
  if (length > RTE_LIMITS.maxFileBytes) resource('Encoded RTE exceeds the file byte limit.');
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x41, 0x52, 0x52, 0x54]);
  view.setUint16(4, 1, true);
  view.setUint16(8, 64, true);
  view.setUint16(10, 24, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 64, true);
  view.setUint16(20, sections.length, true);
  bytes.set(route.routeId, 24);
  view.setUint32(40, route.revision, true);
  let offset = 64 + 24 * sections.length;
  sections.forEach((section, i) => {
    offset = align4(offset);
    const entry = 64 + i * 24;
    bytes.set([...section.type].map(char => char.charCodeAt(0)), entry);
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 1, true);
    view.setUint32(entry + 8, offset, true);
    view.setUint32(entry + 12, section.bytes.length, true);
    view.setUint32(entry + 16, section.size, true);
    view.setUint32(entry + 20, section.count, true);
    bytes.set(section.bytes, offset);
    offset += section.bytes.length;
  });
  view.setUint32(44, crc32(bytes, true), true);
  return bytes;
}

interface DirectoryEntry { type: string; flags: number; version: number; offset: number; length: number; size: number; count: number }

/** Full V1 reader: CRC, layout, canonical CBOR, records, and all cross-section relationships. */
export function decodeRte(bytes: Uint8Array): RouteData {
  if (!(bytes instanceof Uint8Array)) invalid('RTE input must be a Uint8Array.');
  if (bytes.length > RTE_LIMITS.maxFileBytes) resource('RTE exceeds the file byte limit.');
  if (bytes.length < 64) invalid('Truncated RTE header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'ARRT') invalid('Incorrect RTE magic.');
  if (view.getUint16(4, true) !== 1) throw new RteError('unsupported', 'Unsupported RTE major version.');
  // Higher minor versions retain the understood core rules; do not reject solely on minor.
  if (view.getUint16(8, true) !== 64 || view.getUint16(10, true) !== 24 || view.getUint32(16, true) !== 64) invalid('Incorrect RTE header or directory constants.');
  if (view.getUint32(12, true) !== bytes.length) invalid('RTE file_size does not equal the actual length.');
  if (view.getUint16(22, true) !== 0 || bytes.subarray(48, 64).some(n => n !== 0)) invalid('RTE flags and reserved bytes must be zero.');
  const routeId = bytes.slice(24, 40);
  if (!routeId.some(n => n !== 0)) invalid('RTE route ID must not be all zero.');
  const revision = view.getUint32(40, true);
  if (revision === 0) invalid('RTE revision must be positive.');
  const count = view.getUint16(20, true);
  if (count < 3) invalid('RTE needs at least three sections.');
  if (count > RTE_LIMITS.maxSections) resource('RTE exceeds the directory entry limit.');
  const directoryEnd = 64 + count * 24;
  if (directoryEnd > bytes.length) invalid('Truncated RTE directory.');
  const directory = new Map<string, DirectoryEntry>();
  let end = directoryEnd;
  for (let i = 0; i < count; i++) {
    const p = 64 + 24 * i;
    const entry: DirectoryEntry = {
      type: String.fromCharCode(...bytes.subarray(p, p + 4)), flags: view.getUint16(p + 4, true),
      version: view.getUint16(p + 6, true), offset: view.getUint32(p + 8, true), length: view.getUint32(p + 12, true),
      size: view.getUint32(p + 16, true), count: view.getUint32(p + 20, true),
    };
    if (!/^[A-Z0-9]{4}$/.test(entry.type)) invalid('Section type is not an uppercase alphanumeric FourCC.');
    if (directory.has(entry.type)) invalid('Duplicate RTE section type.');
    if ((entry.flags & ~1) !== 0) invalid('Section uses an undefined flag bit.');
    if (entry.length === 0 || entry.offset !== align4(end) || entry.offset > bytes.length || entry.length > bytes.length - entry.offset) {
      invalid('Invalid section alignment, placement, length, or overlap.');
    }
    for (let padding = end; padding < entry.offset; padding++) if (bytes[padding] !== 0) invalid('Inter-section padding must be zero.');
    if ((entry.size === 0) !== (entry.count === 0)) invalid('Record size and count must both be zero or both positive.');
    const product = entry.size * entry.count;
    if (entry.size !== 0 && (!Number.isSafeInteger(product) || product !== entry.length)) invalid('Record size/count product does not match section length.');
    end = entry.offset + entry.length;
    directory.set(entry.type, entry);
  }
  if (end !== bytes.length) invalid('RTE contains trailing padding or unregistered data.');
  if (view.getUint32(44, true) !== crc32(bytes, true)) invalid('RTE CRC32 mismatch.');
  const known = new Set(['META', 'GEOM', 'ELEV', 'GIDX']);
  for (const entry of directory.values()) {
    if (known.has(entry.type)) {
      if (entry.flags !== 1) invalid(`${entry.type} must be marked MUST_UNDERSTAND.`);
      if (entry.version !== 1) throw new RteError('unsupported', `Unsupported ${entry.type} version ${entry.version}.`);
    } else if (entry.flags & 1) throw new RteError('unsupported', `Unknown critical section ${entry.type}.`);
  }
  function required(type: string, size: number, minimum: number, limit: number): DirectoryEntry {
    const entry = directory.get(type);
    if (!entry) invalid(`Missing ${type} section.`);
    if (entry.size !== size || entry.count < minimum) invalid(`Incorrect ${type} record size or count.`);
    if (entry.count > limit) resource(`${type} exceeds the record limit.`);
    return entry;
  }
  const metaEntry = required('META', 0, 0, 0);
  if (metaEntry.count !== 0) invalid('META must not be a record section.');
  const metadata = decodeMeta(decodeCbor(bytes.subarray(metaEntry.offset, metaEntry.offset + metaEntry.length)));
  const geomEntry = required('GEOM', 12, 2, RTE_LIMITS.maxGeometryNodes);
  const geom: GeomNode[] = [];
  for (let i = 0; i < geomEntry.count; i++) {
    const p = geomEntry.offset + i * 12;
    geom.push({ latE7: view.getInt32(p, true), lonE7: view.getInt32(p + 4, true), sDm: view.getUint32(p + 8, true) });
  }
  let elev: ElevNode[] | undefined;
  if (directory.has('ELEV')) {
    const entry = required('ELEV', 16, 2, RTE_LIMITS.maxElevationNodes);
    elev = [];
    for (let i = 0; i < entry.count; i++) {
      const p = entry.offset + i * 16;
      elev.push({ sDm: view.getUint32(p, true), hDm: view.getInt32(p + 4, true), upDm: view.getUint32(p + 8, true), downDm: view.getUint32(p + 12, true) });
    }
  }
  const route: RouteData = { routeId, revision, ...metadata, geom, ...(elev ? { elev } : {}) };
  validateRoute(route);
  const index = required('GIDX', 32, 1, RTE_LIMITS.maxIndexRecords);
  let nextFirst = 0;
  for (let i = 0; i < index.count; i++) {
    const p = index.offset + i * 32;
    const first = view.getUint32(p, true);
    const nodeCount = view.getUint32(p + 4, true);
    if (first !== nextFirst || nodeCount < 2 || nodeCount > 129 || first + nodeCount > geom.length) invalid('GIDX has invalid segment coverage.');
    const expected = indexBlock(geom, first, nodeCount);
    if (view.getUint32(p + 8, true) !== expected.sBegin || view.getUint32(p + 12, true) !== expected.sEnd ||
      view.getInt32(p + 16, true) !== expected.minLat || view.getInt32(p + 20, true) !== expected.maxLat ||
      view.getInt32(p + 24, true) !== expected.minLon || view.getInt32(p + 28, true) !== expected.maxLon) {
      invalid('GIDX distance bounds or coordinate bounds are incorrect.');
    }
    nextFirst = first + nodeCount - 1;
  }
  if (nextFirst !== geom.length - 1) invalid('GIDX does not cover every GEOM segment.');
  return route;
}

/** Queries a validated profile in dm; intermediate values deliberately retain fractions. */
export function queryElevation(nodes: ElevNode[], sDm: number): ProfileValue {
  if (!nodes || nodes.length < 2) throw new RteError('unavailable', 'This route has no complete elevation profile.');
  if (!Number.isFinite(sDm) || sDm < nodes[0].sDm || sDm > nodes[nodes.length - 1].sDm) throw new RteError('range', 'Elevation query is outside the route.');
  let low = 0;
  let high = nodes.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (nodes[mid].sDm < sDm) low = mid + 1;
    else high = mid;
  }
  const right = nodes[low];
  if (right.sDm === sDm) return { hDm: right.hDm, upDm: right.upDm, downDm: right.downDm };
  const left = nodes[low - 1];
  const fraction = (sDm - left.sDm) / (right.sDm - left.sDm);
  return {
    hDm: left.hDm + fraction * (right.hDm - left.hDm),
    upDm: left.upDm + fraction * (right.upDm - left.upDm),
    downDm: left.downDm + fraction * (right.downDm - left.downDm),
  };
}

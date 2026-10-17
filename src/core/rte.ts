import { CBOR_LIMITS, decodeCbor, encodeCbor, invalid, resource, RteError, textBytes } from './cbor';
import type { CborValue } from './cbor';
import type { ElevationInfo, MagneticDeclinationInfo, ElevNode, GeomNode, ProfileValue, RouteData, Stage, StationEvent } from './types';

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

/** Valid UTC Gregorian calendar date, including years before 0100. */
function calendarDate(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) invalid('Date must use YYYY-MM-DD.');
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid('Invalid Gregorian calendar date.');
  return value;
}

export function validateMagneticDeclination(info: MagneticDeclinationInfo): void {
  object(info, 'Magnetic declination');
  integer(info.declinationCdeg, -18000, 18000, 'Declination');
  integer(info.referenceLatE7, -LAT, LAT, 'Declination reference latitude');
  integer(info.referenceLonE7, -LON, LON - 1, 'Declination reference longitude');
  calendarDate(info.referenceDate);
  string(info.source, 64, 'Declination source');
  if ((info.validFrom === undefined) !== (info.validUntil === undefined)) invalid('Declination validity dates must appear together.');
  if (info.validFrom !== undefined && info.validUntil !== undefined) {
    calendarDate(info.validFrom); calendarDate(info.validUntil);
    if (info.validFrom > info.referenceDate || info.referenceDate > info.validUntil) invalid('Declination reference date must be inside the validity interval.');
  }
}

/** Uses only a caller-supplied trusted UTC date when an applicability interval is declared. */
export function queryMagneticDeclination(info: MagneticDeclinationInfo | undefined, date?: string): { declinationCdeg: number; applicability: 'applicable' | 'unspecified' } {
  if (date !== undefined) calendarDate(date);
  if (info === undefined) throw new RteError('unavailable', 'Magnetic declination is unavailable.', 'unavailable');
  validateMagneticDeclination(info);
  if (info.validFrom !== undefined) {
    if (date === undefined) throw new RteError('unavailable', 'Magnetic declination requires a trusted UTC query date.', 'time_unknown');
    if (date < info.validFrom || date > info.validUntil!) throw new RteError('unavailable', 'Magnetic declination is unavailable for this date.', 'outside_interval');
  }
  return { declinationCdeg: info.declinationCdeg, applicability: info.validFrom === undefined ? 'unspecified' : 'applicable' };
}

export function convertHeading(headingCdeg: number, info: MagneticDeclinationInfo | undefined, date: string | undefined, target: 'true' | 'magnetic'): number {
  if (!Number.isFinite(headingCdeg)) throw new RteError('range', 'Heading must be finite.');
  const { declinationCdeg } = queryMagneticDeclination(info, date);
  const value = (headingCdeg % 36000) + (target === 'true' ? declinationCdeg : -declinationCdeg);
  return value - 36000 * Math.floor(value / 36000);
}

function decodeMeta(value: CborValue): Omit<RouteData, 'routeId' | 'revision' | 'geom' | 'elev'> {
  const root = structured(value, [0, 1, 2, 3, 4, 5, 7, 8, 9], 'META');
  const schema = integer(root.get(0), 0, U32, 'META.schema_version');
  if (schema !== 1) throw new RteError('unsupported', `Unsupported META schema ${schema}.`);
  if (integer(root.get(4), 0, U32, 'META.coordinate_ref') !== 1) invalid('META.coordinate_ref must be WGS84 E7 (1).');
  const name = string(root.get(1), 96, 'Route name', true);
  const totalSDm = integer(root.get(2), 1, U32, 'META.total_s_dm');
  const routeKind = integer(root.get(3), 0, 1, 'META.route_kind') as 0 | 1;
  const info = structured(root.get(5), [0, 1, 2, 3, 4, 5], 'META.elevation');
  const elevationInfo: ElevationInfo = {
    source: integer(info.get(0), 0, 4, 'Elevation source') as ElevationInfo['source'],
    verticalDatum: integer(info.get(1), 0, 3, 'Vertical datum') as ElevationInfo['verticalDatum'],
    quality: integer(info.get(2), 0, 2, 'Elevation quality') as ElevationInfo['quality'],
  };
  if (info.has(3)) elevationInfo.sourceDetail = string(info.get(3), 128, 'Elevation source detail');
  if (info.has(4)) elevationInfo.datumName = string(info.get(4), 64, 'Elevation datum name');
  if (info.has(5)) elevationInfo.containsFilledValues = boolean(info.get(5), 'Elevation contains filled values');
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
        minHDm: integer(entry.get(2), I32_MIN, I32_MAX, 'Stage minimum elevation'),
        maxHDm: integer(entry.get(3), I32_MIN, I32_MAX, 'Stage maximum elevation'),
      };
      return stage;
    });
  }
  let magneticDeclination: MagneticDeclinationInfo | undefined;
  if (root.has(9)) {
    const info = structured(root.get(9), [0, 1, 2, 3, 4, 6, 7], 'META.magnetic_declination');
    magneticDeclination = {
      declinationCdeg: info.get(0) as number, referenceLatE7: info.get(1) as number,
      referenceLonE7: info.get(2) as number, referenceDate: info.get(3) as string, source: info.get(4) as string,
      ...(info.has(6) ? { validFrom: info.get(6) as string } : {}),
      ...(info.has(7) ? { validUntil: info.get(7) as string } : {}),
    };
    validateMagneticDeclination(magneticDeclination);
  }
  return { name, totalSDm, routeKind, stations, elevationInfo, ...(magneticDeclination ? { magneticDeclination } : {}), ...(stages ? { stages } : {}) };
}

function toMeta(route: RouteData): Map<number, CborValue> {
  object(route, 'Route');
  array(route.stations, 2, 4096, 'Stations');
  const stations = route.stations.map(station => {
    object(station, 'Station');
    return map([[0, station.eventId], [1, station.name], [2, station.shortLabel], [3, station.kind],
      [4, station.stageBoundary], [5, station.sDm], [6, station.actualLatE7], [7, station.actualLonE7]]);
  });
  const meta = map([[0, 1], [1, route.name], [2, route.totalSDm], [3, route.routeKind], [4, 1], [7, stations]]);
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
      return map([[0, stage.fromEventId], [1, stage.toEventId], [2, stage.minHDm], [3, stage.maxHDm]]);
    }));
  }
  if (route.magneticDeclination !== undefined) {
    const d = route.magneticDeclination;
    validateMagneticDeclination(d);
    const info = map([[0, d.declinationCdeg], [1, d.referenceLatE7], [2, d.referenceLonE7], [3, d.referenceDate], [4, d.source]]);
    if (d.validFrom !== undefined) info.set(6, d.validFrom);
    if (d.validUntil !== undefined) info.set(7, d.validUntil);
    meta.set(9, info);
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
  const elevationDistances = new Set<number>();
  if (!Array.isArray(route.elev) || route.elev.length < 2) invalid('ELEV requires at least two nodes.');
  if (route.elev.length > RTE_LIMITS.maxElevationNodes) resource('ELEV exceeds the node limit.');
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
      if (!geometryDistances.has(event.sDm) || !elevationDistances.has(event.sDm)) {
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
  sections.push(recordSection('ELEV', 16, route.elev.length, (view, i, offset) => {
    const n = route.elev[i];
    view.setUint32(offset, n.sDm, true);
    view.setInt32(offset + 4, n.hDm, true);
    view.setUint32(offset + 8, n.upDm, true);
    view.setUint32(offset + 12, n.downDm, true);
  }));
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
  if (count < 4) invalid('RTE needs at least four sections.');
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
  const elevEntry = required('ELEV', 16, 2, RTE_LIMITS.maxElevationNodes);
  const elev: ElevNode[] = [];
  for (let i = 0; i < elevEntry.count; i++) {
    const p = elevEntry.offset + i * 16;
    elev.push({ sDm: view.getUint32(p, true), hDm: view.getInt32(p + 4, true), upDm: view.getUint32(p + 8, true), downDm: view.getUint32(p + 12, true) });
  }
  const route: RouteData = { routeId, revision, ...metadata, geom, elev };
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

/** Queries validated GEOM by reference distance; returned degrees retain interpolation precision. */
export function queryGeometry(nodes: GeomNode[], sDm: number): { lat: number; lon: number } {
  if (!nodes || nodes.length < 2) throw new RteError('unavailable', 'This route has no complete geometry.');
  if (!Number.isFinite(sDm) || sDm < nodes[0].sDm || sDm > nodes[nodes.length - 1].sDm) throw new RteError('range', 'Geometry query is outside the route.');
  let low = 0;
  let high = nodes.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (nodes[mid].sDm < sDm) low = mid + 1;
    else high = mid;
  }
  const right = nodes[low];
  if (right.sDm === sDm) return { lat: right.latE7 / 1e7, lon: right.lonE7 / 1e7 };
  const left = nodes[low - 1];
  const fraction = (sDm - left.sDm) / (right.sDm - left.sDm);
  let deltaLon = right.lonE7 - left.lonE7;
  // Strict comparisons preserve the sign of exact +180° and -180° differences.
  if (deltaLon > LON) deltaLon -= 2 * LON;
  if (deltaLon < -LON) deltaLon += 2 * LON;
  const lon = (left.lonE7 + fraction * deltaLon) / 1e7;
  return {
    lat: (left.latE7 + fraction * (right.latE7 - left.latE7)) / 1e7,
    lon: lon - 360 * Math.floor((lon + 180) / 360),
  };
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

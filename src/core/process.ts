import { cleanLabel } from './import';
import type { DraftStation, ElevNode, GeomNode, MatchCandidate, ProcessingIssue, ProcessingOptions, ProcessingResult, ReferencePoint, ReferenceRoute, RouteIdentity, SourceLandmark, SourcePoint, SourceRoute, Stage, StationEvent } from './types';

export const MAX_INTERPOLATION_GAP_M = 100;
export const MAX_GEOMETRY_EDGE_M = 250;
const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;
const UINT32_MAX = 0xffff_ffff;
const encoder = new TextEncoder();
const issueText: Record<string, string> = {
  ROUTE_TOO_SHORT: 'The cleaned route needs at least two distinct points and a length of 0.1 m.',
  DUPLICATE_COORDINATES: 'Consecutive duplicate coordinates were merged without changing traversal order.',
  ELEVATION_CONFLICT: 'Conflicting elevations at repeated coordinates are marked missing. Explicitly fill short gaps or omit elevation.',
  ELEVATION_MISSING: 'Some route points have no elevation. Zero elevation is preserved as valid data.',
  LARGE_SOURCE_EDGE: 'Some adjacent source coordinates are more than 1 km apart. Check their connections on the map.',
  GEOMETRY_RESOURCE_LIMIT: 'This route requires too many geometry nodes for the browser processing budget.',
  GEOMETRY_QUANTIZATION_COLLISION: 'Stage boundaries cannot be represented by distinct E7 geometry nodes. Move a boundary or disable its stage split.',
  GEOMETRY_QUANTIZATION_MERGE: 'Coincident geometry nodes were resolved after coordinate quantization.',
  INCOMPLETE_ELEVATION: 'A complete elevation profile is unavailable. Only explicitly requested interior gaps of at most 100 m can be filled; endpoints and longer gaps cannot be extrapolated.',
  PROFILE_RESOURCE_LIMIT: 'Elevation sampling exceeds 200,000 nodes. Increase the sampling interval.',
  ELEVATION_RANGE: 'An elevation value exceeds the RTE signed 32-bit decimeter range.',
  ELEVATION_TOTAL_RANGE: 'Cumulative ascent or descent exceeds the RTE unsigned 32-bit decimeter range.',
  ELEVATION_FILLED: 'Interior elevation gaps of at most 100 m were explicitly filled by distance-based linear interpolation.',
  IDENTITY_INVALID: 'The route identity or revision is invalid.',
  ROUTE_NAME_INVALID: 'The route name must contain 1–96 UTF-8 bytes and no control characters.',
  SOURCE_HASH_INVALID: 'The source SHA-256 must contain exactly 32 bytes.',
  DISTANCE_RANGE: 'The route distance is outside the RTE range.',
  OPTIONS_INVALID: 'Invalid settings: geometry tolerance 0–1000 m, elevation interval 0.1–1000 m, smoothing window 0–10000 m.',
  STATION_COUNT: 'A route needs 2–4096 station events.',
  STATION_UNCONFIRMED: 'Confirm this station’s along-route visit before exporting.',
  STATION_NAME_INVALID: 'A station name or short label exceeds its UTF-8 byte limit or contains invalid characters.',
  STATION_INVALID: 'A station has invalid event fields or coordinates.',
  EVENT_ID_DUPLICATE: 'Station event IDs must be unique.',
  ENDPOINT_EVENTS: 'Exactly one start and finish must be the first and last events, at zero and the total distance, both defining stage boundaries.',
  BOUNDARY_COLLISION: 'Stage boundaries coincide after decimeter quantization. Move one or disable its stage split.',
  ELEVATION_UNCONFIRMED: 'Confirm that KML altitude values represent route ground elevation, or omit elevation.',
};
const issue = (code: string, messageZh: string, severity: ProcessingIssue['severity'] = 'error', s?: number): ProcessingIssue => {
  const label = messageZh.match(/“([^”]+)”/)?.[1];
  const count = /^(?:已合并 )?(\d+)/.exec(messageZh)?.[1];
  return { code, message: `${issueText[code] ?? messageZh}${label ? ` (${label})` : ''}${count ? ` Count: ${count}.` : ''}`, messageZh, severity, ...(s === undefined ? {} : { s }) };
};

export function quantize(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Cannot quantize a non-finite value.');
  return value < 0 ? Math.ceil(value - 0.5) : Math.floor(value + 0.5);
}
export function normalizeLongitude(value: number): number {
  return value >= -180 && value < 180 ? value : ((value + 180) % 360 + 360) % 360 - 180;
}
const deltaLon = (a: number, b: number) => normalizeLongitude(b - a);
const sameCoordinate = (a: SourcePoint, b: SourcePoint) => a.lat === b.lat && deltaLon(a.lon, b.lon) === 0;
const lonE7 = (value: number) => { const result = quantize(normalizeLongitude(value) * 1e7); return result === 1_800_000_000 ? -1_800_000_000 : result; };

/** Horizontal great-circle distance over WGS84 coordinates, with antimeridian wrapping. */
export function distanceM(a: Pick<SourcePoint, 'lat' | 'lon'>, b: Pick<SourcePoint, 'lat' | 'lon'>): number {
  const phi = (b.lat - a.lat) * RAD;
  const lambda = deltaLon(a.lon, b.lon) * RAD;
  const h = Math.sin(phi / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(lambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function buildReference(source: SourceRoute, options: { reverse?: boolean; startIndex?: number } = {}): ReferenceRoute {
  let sourcePoints = source.points.map((point, sourceIndex) => ({ ...point, sourceIndex, lon: normalizeLongitude(point.lon) }));
  const issues: ProcessingIssue[] = [];
  if (sourcePoints.some((point) => !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90 || !Number.isFinite(point.lon) || (point.elevation !== null && !Number.isFinite(point.elevation)))) throw new Error('The route contains invalid coordinates or elevation.');
  const closed = sourcePoints.length > 2 && sameCoordinate(sourcePoints[0], sourcePoints[sourcePoints.length - 1]);
  if (closed) sourcePoints[sourcePoints.length - 1].sourceIndex = 0;
  if (options.startIndex !== undefined && options.startIndex !== 0) {
    if (!closed) throw new Error('Only explicitly closed routes can change their starting point.');
    if (!Number.isInteger(options.startIndex) || options.startIndex < 0 || options.startIndex >= sourcePoints.length - 1) throw new Error('The closed-route start index is invalid.');
    // Keep both observations at the original closing seam, so any contradictory
    // elevations are reported by duplicate cleaning rather than silently discarded.
    sourcePoints = [...sourcePoints.slice(options.startIndex), ...sourcePoints.slice(0, options.startIndex + 1)];
  }
  if (options.reverse) sourcePoints.reverse();
  const points: ReferencePoint[] = [];
  let duplicates = 0;
  let conflicts = 0;
  let largeEdges = 0;
  let previousWasConflicted = false;
  let previousKnownElevation: number | null = null;
  for (const point of sourcePoints) {
    const previous = points[points.length - 1];
    if (previous && sameCoordinate(previous, point)) {
      duplicates++;
      if (!previousWasConflicted && previousKnownElevation !== null && point.elevation !== null && previousKnownElevation !== point.elevation) {
        conflicts++;
        previousWasConflicted = true;
      }
      // Missing or contradictory observations cannot be silently upgraded to a known height.
      if (previous.elevation === null || point.elevation === null || previousWasConflicted) previous.elevation = null;
      if (previousKnownElevation === null && point.elevation !== null) previousKnownElevation = point.elevation;
      continue;
    }
    previousWasConflicted = false;
    previousKnownElevation = point.elevation;
    const length = previous ? distanceM(previous, point) : 0;
    if (length > 1000) largeEdges++;
    points.push({ ...point, s: (previous?.s ?? 0) + length });
  }
  const totalM = points[points.length - 1]?.s ?? 0;
  if (points.length < 2 || totalM < 0.1) issues.push(issue('ROUTE_TOO_SHORT', '清理后路线不足两个有效点或不足 0.1 米。'));
  if (duplicates) issues.push(issue('DUPLICATE_COORDINATES', `已合并 ${duplicates} 个连续重复坐标，保留经过顺序。`, 'warning'));
  if (conflicts) issues.push(issue('ELEVATION_CONFLICT', `${conflicts} 处重复坐标的高程冲突，已标为缺失；可明确补全短缺口或省略高程。`, 'warning'));
  const missing = points.filter((point) => point.elevation === null).length;
  if (missing) issues.push(issue('ELEVATION_MISSING', `${missing} 个有效路线点缺少高程。`, 'warning'));
  if (largeEdges) issues.push(issue('LARGE_SOURCE_EDGE', `${largeEdges} 段相邻源坐标相距超过 1 km，请核对地图中的连接。`, 'warning'));
  return { points, totalM, isClosed: closed, elevationDatum: source.elevationDatum, elevationUncertain: source.elevationUncertain, issues };
}

function bracket(points: ReferencePoint[], s: number): number {
  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].s <= s) low = middle;
    else high = middle;
  }
  return low;
}
function interpolate(a: SourcePoint, b: SourcePoint, t: number): SourcePoint {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: normalizeLongitude(a.lon + deltaLon(a.lon, b.lon) * t), elevation: a.elevation === null || b.elevation === null ? null : a.elevation + (b.elevation - a.elevation) * t };
}

export function positionAt(reference: ReferenceRoute, s: number): SourcePoint {
  if (!Number.isFinite(s) || s < 0 || s > reference.totalM || reference.points.length < 2) throw new Error('The requested distance is outside the route range.');
  const last = reference.points[reference.points.length - 1];
  if (s === reference.totalM) return { lat: last.lat, lon: last.lon, elevation: last.elevation };
  const index = bracket(reference.points, s);
  const a = reference.points[index];
  if (a.s === s) return { lat: a.lat, lon: a.lon, elevation: a.elevation };
  const b = reference.points[index + 1];
  return interpolate(a, b, (s - a.s) / (b.s - a.s));
}

function project(a: SourcePoint, b: SourcePoint, point: Pick<SourcePoint, 'lat' | 'lon'>): { t: number; distanceM: number; lat: number; lon: number } {
  const cosLat = Math.cos((a.lat + b.lat + point.lat) / 3 * RAD);
  const x = deltaLon(a.lon, b.lon) * RAD * EARTH_RADIUS_M * cosLat;
  const y = (b.lat - a.lat) * RAD * EARTH_RADIUS_M;
  const px = deltaLon(a.lon, point.lon) * RAD * EARTH_RADIUS_M * cosLat;
  const py = (point.lat - a.lat) * RAD * EARTH_RADIUS_M;
  const denominator = x * x + y * y;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, (px * x + py * y) / denominator));
  const projected = interpolate(a, b, t);
  return { t, distanceM: distanceM(point, projected), lat: projected.lat, lon: projected.lon };
}

export function matchLandmark(reference: ReferenceRoute, landmark: SourceLandmark): MatchCandidate[] {
  if (reference.points.length < 2) return [];
  const projections: MatchCandidate[] = [];
  let nearest = Infinity;
  for (let index = 1; index < reference.points.length; index++) {
    const a = reference.points[index - 1];
    const b = reference.points[index];
    const result = project(a, b, landmark);
    nearest = Math.min(nearest, result.distanceM);
    projections.push({ s: a.s + result.t * (b.s - a.s), distanceM: result.distanceM, lat: result.lat, lon: result.lon });
  }
  const candidates: MatchCandidate[] = [];
  for (let index = 0; index < projections.length; index++) {
    const value = projections[index];
    if (value.distanceM > nearest + 20) continue;
    if (index > 0 && projections[index - 1].distanceM < value.distanceM) continue;
    if (index + 1 < projections.length && projections[index + 1].distanceM < value.distanceM) continue;
    const previous = candidates[candidates.length - 1];
    if (previous && value.s - previous.s < 20) {
      if (value.distanceM < previous.distanceM) candidates[candidates.length - 1] = value;
    } else candidates.push(value);
  }
  return candidates.sort((a, b) => a.distanceM - b.distanceM || a.s - b.s).slice(0, 32);
}

function shortLabel(name: string): string {
  const preferred = name.match(/^(?:CP\s*)?[A-Za-z]*\d+/i)?.[0] ?? name;
  let result = '';
  for (const char of preferred) { if (encoder.encode(result + char).length > 16) break; result += char; }
  return result || 'POI';
}

export function createStations(reference: ReferenceRoute, landmarks: SourceLandmark[]): DraftStation[] {
  if (reference.points.length < 2) return [];
  const first = reference.points[0];
  const last = reference.points[reference.points.length - 1];
  const start: DraftStation = { id: 1, name: 'Start', shortLabel: 'START', kind: 0, stageBoundary: true, s: 0, lat: first.lat, lon: first.lon, confirmed: true, candidates: [] };
  const finish: DraftStation = { id: 2, name: 'Finish', shortLabel: 'FINISH', kind: 1, stageBoundary: true, s: reference.totalM, lat: last.lat, lon: last.lon, confirmed: true, candidates: [] };
  const stations: DraftStation[] = [];
  for (const landmark of landmarks) {
    const name = cleanLabel(landmark.name) || 'Station';
    const combined = /起终点|起終點|start\s*[/&-]\s*finish/i.test(name);
    const isStart = combined || /起点|起點|\bstart\b/i.test(name);
    const isFinish = combined || /终点|終點|\bfinish\b/i.test(name);
    const startDistance = distanceM(first, landmark);
    const finishDistance = distanceM(last, landmark);
    let consumed = false;
    if ((isStart || isFinish) && startDistance <= 100 && (reference.isClosed ? isStart : startDistance <= finishDistance)) {
      const endpointName = isStart ? name : `Start · ${name}`;
      if (start.name === 'Start' || endpointName.length >= start.name.length) Object.assign(start, { name: endpointName, lat: landmark.lat, lon: landmark.lon });
      consumed = true;
    }
    if ((isStart || isFinish) && finishDistance <= 100 && (reference.isClosed ? isFinish : finishDistance <= startDistance)) {
      const endpointName = isFinish ? name : `Finish · ${name}`;
      if (finish.name === 'Finish' || endpointName.length >= finish.name.length) Object.assign(finish, { name: endpointName, lat: landmark.lat, lon: landmark.lon });
      consumed = true;
    }
    if (consumed) continue;
    const candidates = matchLandmark(reference, landmark);
    const chosen = candidates[0];
    if (!chosen) continue;
    stations.push({ id: 0, name, shortLabel: shortLabel(name), kind: /water|补水|補水|水站/i.test(name) ? 3 : 2,
      stageBoundary: chosen.s > 0.05 && reference.totalM - chosen.s > 0.05,
      s: chosen.s, lat: landmark.lat, lon: landmark.lon, confirmed: candidates.length === 1 && chosen.distanceM <= 50, candidates });
  }
  stations.sort((a, b) => a.s - b.s);
  return [start, ...stations, finish].map((station, index) => ({ ...station, id: index + 1 }));
}

interface WorkPoint extends ReferencePoint { required: boolean }

/** Constrain both lateral deviation and progress interpolation before quantizing. */
function simplify(points: WorkPoint[], toleranceM: number): WorkPoint[] {
  const keep = new Uint8Array(points.length);
  const anchors: number[] = [];
  points.forEach((point, index) => { if (point.required) { anchors.push(index); keep[index] = 1; } });
  const stack: [number, number][] = anchors.slice(1).map((end, index) => [anchors[index], end]);
  while (stack.length) {
    const [start, end] = stack.pop()!;
    if (end - start <= 1) continue;
    const a = points[start];
    const b = points[end];
    let split = -1;
    let maximumScore = 1;
    // A closed chord must keep an intermediate point even at very large tolerances.
    if (b.s - a.s > MAX_GEOMETRY_EDGE_M || sameCoordinate(a, b)) {
      const midpoint = (a.s + b.s) / 2;
      split = start + 1;
      for (let index = start + 2; index < end; index++) if (Math.abs(points[index].s - midpoint) < Math.abs(points[split].s - midpoint)) split = index;
    } else {
      for (let index = start + 1; index < end; index++) {
        const candidate = points[index];
        const projection = project(a, b, candidate);
        const progressError = Math.abs(candidate.s - (a.s + projection.t * (b.s - a.s)));
        const score = Math.max(projection.distanceM / Math.max(0.000001, toleranceM), progressError / Math.max(2, toleranceM));
        if (score > maximumScore) { maximumScore = score; split = index; }
      }
    }
    if (split !== -1) { keep[split] = 1; stack.push([start, split], [split, end]); }
  }
  return points.filter((_, index) => keep[index]);
}

function geometry(reference: ReferenceRoute, boundaryDm: number[], tolerance: number, issues: ProcessingIssue[]): GeomNode[] {
  const totalDm = Number.isFinite(reference.totalM) ? quantize(reference.totalM * 10) : 0;
  const nodes: WorkPoint[] = reference.points.map((point) => ({ ...point, required: false }));
  // Sparse source edges are subdivided along their represented segment, without changing distance.
  for (let index = 1; index < reference.points.length; index++) {
    const a = reference.points[index - 1];
    const b = reference.points[index];
    const pieces = Math.ceil((b.s - a.s) / MAX_GEOMETRY_EDGE_M);
    if (nodes.length + pieces > 400_000) { issues.push(issue('GEOMETRY_RESOURCE_LIMIT', '路线太长或源点过于稀疏，无法在浏览器预算内细分几何。')); return []; }
    for (let step = 1; step < pieces; step++) nodes.push({ ...interpolate(a, b, step / pieces), s: a.s + (b.s - a.s) * step / pieces, required: false });
  }
  for (const dm of boundaryDm) {
    const s = dm === totalDm ? reference.totalM : Math.min(reference.totalM, dm / 10);
    nodes.push({ ...positionAt(reference, s), s, required: true });
  }
  nodes.sort((a, b) => a.s - b.s || Number(a.required) - Number(b.required));
  const distinct: WorkPoint[] = [];
  for (const node of nodes) {
    const previous = distinct[distinct.length - 1];
    if (previous && quantize(previous.s * 10) === quantize(node.s * 10)) {
      if (node.required || !previous.required) distinct[distinct.length - 1] = node;
    } else distinct.push(node);
  }
  if (distinct.length) { distinct[0].required = true; distinct[distinct.length - 1].required = true; }
  const simplified = simplify(distinct, tolerance);
  const output: (GeomNode & { required: boolean })[] = [];
  let removed = 0;
  for (const point of simplified) {
    const node = { latE7: quantize(point.lat * 1e7), lonE7: lonE7(point.lon), sDm: quantize(point.s * 10), required: point.required };
    let previous = output[output.length - 1];
    while (previous && previous.latE7 === node.latE7 && previous.lonE7 === node.lonE7) {
      if (previous.required && node.required) { issues.push(issue('GEOMETRY_QUANTIZATION_COLLISION', '两个阶段边界在 E7 量化后无法形成有效线段，请调整或取消其中的阶段边界。', 'error', point.s)); return []; }
      removed++;
      if (!node.required) break;
      output.pop();
      previous = output[output.length - 1];
    }
    if (previous && previous.latE7 === node.latE7 && previous.lonE7 === node.lonE7) continue;
    output.push(node);
  }
  if (removed) issues.push(issue('GEOMETRY_QUANTIZATION_MERGE', `已消解 ${removed} 个量化后重合的几何节点。`, 'warning'));
  if (output.length < 2) issues.push(issue('GEOMETRY_QUANTIZATION_COLLISION', 'E7 量化后没有足够的不同几何节点。'));
  return output.map(({ latE7, lonE7: longitude, sDm }) => ({ latE7, lonE7: longitude, sDm }));
}

function repairedProfile(reference: ReferenceRoute, mode: ProcessingOptions['elevationMode'], issues: ProcessingIssue[]): { points: ReferencePoint[]; filled: boolean } | null {
  const points = reference.points.map((point) => ({ ...point }));
  let filled = false;
  for (let index = 0; index < points.length; index++) {
    if (points[index].elevation !== null) continue;
    const firstMissing = index;
    while (index < points.length && points[index].elevation === null) index++;
    const left = points[firstMissing - 1];
    const right = points[index];
    if (mode !== 'interpolate' || !left || !right || right.s - left.s > MAX_INTERPOLATION_GAP_M) {
      issues.push(issue('INCOMPLETE_ELEVATION', mode === 'source' ? '源高程不完整，请明确选择补全短缺口或不导出高程。' : `无法补全端点或超过 ${MAX_INTERPOLATION_GAP_M} 米的缺口，请不导出高程或更换数据。`, 'error', points[firstMissing].s));
      return null;
    }
    for (let gap = firstMissing; gap < index; gap++) points[gap].elevation = left.elevation! + (right.elevation! - left.elevation!) * (points[gap].s - left.s) / (right.s - left.s);
    filled = true;
  }
  return { points, filled };
}

function elevation(reference: ReferenceRoute, boundaryDm: number[], options: ProcessingOptions, issues: ProcessingIssue[]): { nodes: ElevNode[]; filled: boolean } | null {
  const profile = repairedProfile(reference, options.elevationMode, issues);
  if (!profile) return null;
  const totalDm = Number.isFinite(reference.totalM) ? quantize(reference.totalM * 10) : 0;
  const intervalDm = quantize(options.elevationIntervalM * 10);
  const sampleCount = Math.ceil(totalDm / intervalDm) + boundaryDm.length;
  if (sampleCount > 200_000) { issues.push(issue('PROFILE_RESOURCE_LIMIT', '高程采样超过 200,000 个节点，请增大采样间隔。')); return null; }
  const sampleDm = new Set(boundaryDm);
  for (let s = intervalDm; s < totalDm; s += intervalDm) sampleDm.add(s);
  sampleDm.add(0);
  sampleDm.add(totalDm);
  const cumulativeArea = [0];
  for (let index = 1; index < profile.points.length; index++) {
    const a = profile.points[index - 1];
    const b = profile.points[index];
    cumulativeArea.push(cumulativeArea[index - 1] + (a.elevation! + b.elevation!) / 2 * (b.s - a.s));
  }
  const height = (s: number): number => {
    if (s >= reference.totalM) return profile.points[profile.points.length - 1].elevation!;
    const index = bracket(profile.points, s);
    const a = profile.points[index];
    const b = profile.points[index + 1];
    return a.elevation! + (b.elevation! - a.elevation!) * (s - a.s) / (b.s - a.s);
  };
  const area = (s: number): number => {
    if (s >= reference.totalM) return cumulativeArea[cumulativeArea.length - 1];
    const index = bracket(profile.points, s);
    return cumulativeArea[index] + (profile.points[index].elevation! + height(s)) / 2 * (s - profile.points[index].s);
  };
  const nodes: ElevNode[] = [];
  for (const sDm of [...sampleDm].sort((a, b) => a - b)) {
    const s = sDm === totalDm ? reference.totalM : Math.min(reference.totalM, sDm / 10);
    const left = Math.max(0, s - options.smoothingWindowM / 2);
    const right = Math.min(reference.totalM, s + options.smoothingWindowM / 2);
    const hDm = quantize((options.smoothingWindowM > 0 ? (area(right) - area(left)) / (right - left) : height(s)) * 10);
    if (hDm < -2_147_483_648 || hDm > 2_147_483_647) { issues.push(issue('ELEVATION_RANGE', '高程超出 RTE 的 i32 分米范围。')); return null; }
    const previous = nodes[nodes.length - 1];
    const delta = previous ? hDm - previous.hDm : 0;
    const node = { sDm, hDm, upDm: (previous?.upDm ?? 0) + Math.max(0, delta), downDm: (previous?.downDm ?? 0) + Math.max(0, -delta) };
    if (node.upDm > UINT32_MAX || node.downDm > UINT32_MAX) { issues.push(issue('ELEVATION_TOTAL_RANGE', '累计升降超出 RTE 的 u32 分米范围。')); return null; }
    nodes.push(node);
  }
  if (profile.filled) issues.push(issue('ELEVATION_FILLED', `已按里程线性补全不超过 ${MAX_INTERPOLATION_GAP_M} 米的内部高程缺口。`, 'warning'));
  return { nodes, filled: profile.filled };
}

function textIssue(value: string, maxBytes: number): boolean {
  return !value || encoder.encode(value).length > maxBytes || /[\u0000-\u001f\u007f]/.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

export function processRoute(reference: ReferenceRoute, stations: DraftStation[], options: ProcessingOptions, identity: RouteIdentity): ProcessingResult {
  const issues: ProcessingIssue[] = [...reference.issues];
  if (identity.routeId.length !== 16 || !identity.routeId.some(Boolean) || !Number.isInteger(identity.revision) || identity.revision < 1 || identity.revision > UINT32_MAX) issues.push(issue('IDENTITY_INVALID', '路线身份或修订号无效。'));
  if (textIssue(identity.name, 96)) issues.push(issue('ROUTE_NAME_INVALID', '路线名称须为 1–96 个 UTF-8 字节，且不能包含控制字符。'));
  if (identity.inputSha256 && identity.inputSha256.length !== 32) issues.push(issue('SOURCE_HASH_INVALID', '输入文件 SHA-256 必须是 32 字节。'));
  if (!Number.isFinite(reference.totalM) || reference.totalM < 0.1 || reference.totalM * 10 > UINT32_MAX) issues.push(issue('DISTANCE_RANGE', '路线总距离超出 RTE 范围。'));
  if (!Number.isFinite(options.geometryToleranceM) || options.geometryToleranceM < 0 || options.geometryToleranceM > 1000 || !Number.isFinite(options.elevationIntervalM) || options.elevationIntervalM < 0.1 || options.elevationIntervalM > 1000 || !Number.isFinite(options.smoothingWindowM) || options.smoothingWindowM < 0 || options.smoothingWindowM > 10_000 || !['omit', 'source', 'interpolate'].includes(options.elevationMode)) issues.push(issue('OPTIONS_INVALID', '处理参数无效：几何容差 0–1000 m、采样间隔 0.1–1000 m、平滑窗口 0–10000 m。'));
  const totalDm = Number.isFinite(reference.totalM) ? quantize(reference.totalM * 10) : 0;
  if (stations.length < 2 || stations.length > 4096) issues.push(issue('STATION_COUNT', '站点事件须为 2–4096 个。'));
  const events: StationEvent[] = stations.map((station) => {
    if (!station.confirmed) issues.push(issue('STATION_UNCONFIRMED', `请确认“${station.name}”对应的经过位置。`, 'error', station.s));
    if (textIssue(station.name, 96) || textIssue(station.shortLabel, 16)) issues.push(issue('STATION_NAME_INVALID', `“${station.name}”的名称或短标签超出 UTF-8 字节限制或含无效字符。`));
    if (!Number.isInteger(station.id) || station.id < 1 || station.id > UINT32_MAX || !Number.isInteger(station.kind) || station.kind < 0 || station.kind > 4 || !Number.isFinite(station.s) || station.s < 0 || station.s > reference.totalM || !Number.isFinite(station.lat) || station.lat < -90 || station.lat > 90 || !Number.isFinite(station.lon)) issues.push(issue('STATION_INVALID', `“${station.name}”的事件字段或坐标无效。`));
    return { eventId: station.id, name: station.name, shortLabel: station.shortLabel, kind: station.kind, stageBoundary: station.stageBoundary, sDm: Number.isFinite(station.s) ? quantize(station.s * 10) : 0, actualLatE7: Number.isFinite(station.lat) ? quantize(station.lat * 1e7) : 0, actualLonE7: Number.isFinite(station.lon) ? lonE7(station.lon) : 0 };
  }).sort((a, b) => a.sDm - b.sDm || a.eventId - b.eventId);
  if (new Set(events.map((event) => event.eventId)).size !== events.length) issues.push(issue('EVENT_ID_DUPLICATE', '站点事件 ID 必须唯一。'));
  const starts = events.filter((event) => event.kind === 0);
  const finishes = events.filter((event) => event.kind === 1);
  if (starts.length !== 1 || finishes.length !== 1 || events[0] !== starts[0] || events[events.length - 1] !== finishes[0] || starts[0]?.sDm !== 0 || finishes[0]?.sDm !== totalDm || !starts[0]?.stageBoundary || !finishes[0]?.stageBoundary) issues.push(issue('ENDPOINT_EVENTS', '路线必须恰有一个起点和终点，分别位于事件首末及里程 0 和全长，且均为阶段边界。'));
  const boundaries = events.filter((event) => event.stageBoundary);
  for (let index = 1; index < boundaries.length; index++) if (boundaries[index].sDm <= boundaries[index - 1].sDm) issues.push(issue('BOUNDARY_COLLISION', '阶段边界在分米量化后重合，请调整里程或取消其中一个阶段边界。', 'error', boundaries[index].sDm / 10));
  if (options.elevationMode !== 'omit' && reference.elevationUncertain && !options.acceptUncertainElevation) issues.push(issue('ELEVATION_UNCONFIRMED', '请确认 KML 高度可以作为路线地面高程，或不导出高程。'));
  if (issues.some((entry) => entry.severity === 'error')) return { route: null, issues };
  const boundaryDm = boundaries.map((event) => event.sDm);
  const geom = geometry(reference, boundaryDm, options.geometryToleranceM, issues);
  const profile = options.elevationMode === 'omit' ? null : elevation(reference, boundaryDm, options, issues);
  if (issues.some((entry) => entry.severity === 'error')) return { route: null, issues };
  const stages: Stage[] = [];
  let profileIndex = 0;
  for (let index = 1; index < boundaries.length; index++) {
    const from = boundaries[index - 1];
    const to = boundaries[index];
    const stage: Stage = { fromEventId: from.eventId, toEventId: to.eventId };
    if (profile) {
      let min = Infinity;
      let max = -Infinity;
      while (profileIndex < profile.nodes.length && profile.nodes[profileIndex].sDm <= to.sDm) {
        const node = profile.nodes[profileIndex];
        min = Math.min(min, node.hDm); max = Math.max(max, node.hDm);
        if (node.sDm === to.sDm) break;
        profileIndex++;
      }
      stage.minHDm = min; stage.maxHDm = max;
    }
    stages.push(stage);
  }
  return { route: {
    routeId: identity.routeId.slice(), revision: identity.revision, name: identity.name, routeKind: reference.isClosed ? 1 : 0,
    totalSDm: totalDm, geom, stations: events, stages,
    ...(profile ? { elev: profile.nodes, elevationInfo: { source: 1 as const, verticalDatum: reference.elevationDatum, quality: 1 as const, sourceDetail: reference.elevationUncertain ? 'User-accepted source altitude; vertical datum unknown' : 'Source file elevation', containsFilledValues: profile.filled } } : {}),
    preprocessing: { tool: 'TRL-X Route Studio', toolVersion: '0.1.0', recipeId: `browser-v1-${options.elevationMode}`, ...(identity.inputSha256 ? { inputSha256: identity.inputSha256.slice() } : {}), parameters: { geometryToleranceDm: quantize(options.geometryToleranceM * 10), ...(profile ? { elevationGridDm: quantize(options.elevationIntervalM * 10), elevationSmoothingWindowDm: quantize(options.smoothingWindowM * 10) } : {}) } },
  }, issues };
}

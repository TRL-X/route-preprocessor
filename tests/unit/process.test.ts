import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, parseRouteFile } from '../../src/core/import';
import { buildReference, createStations, distanceM, matchLandmark, MAX_GEOMETRY_EDGE_M, MAX_INTERPOLATION_GAP_M, positionAt, processRoute, quantize } from '../../src/core/process';
import type { ProcessingOptions, RouteIdentity, SourcePoint, SourceRoute } from '../../src/core/types';
import { decodeRte, encodeRte } from '../../src/core/rte';

const identity: RouteIdentity = { routeId: Uint8Array.from({ length: 16 }, (_, index) => index + 1), revision: 1, name: '测试路线' };
const options: ProcessingOptions = { geometryToleranceM: 3, elevationIntervalM: 10, smoothingWindowM: 0, elevationMode: 'source', acceptUncertainElevation: false };
const point = (lat: number, lon: number, elevation: number | null = 100): SourcePoint => ({ lat, lon, elevation });
const source = (points: SourcePoint[]): SourceRoute => ({ id: 'test', name: 'Test', points, elevationDatum: 0, elevationUncertain: false });
const fixtureDirectory = fileURLToPath(new URL('../fixtures/routes/2026MY/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${fixtureDirectory}/manifest.json`, 'utf8')) as { files: { file: string; format: string; observed: { point_count: number; landmark_count: number; missing_elevation_count: number } }[] };

describe('route import', () => {
  it.each(manifest.files)('reads $file and exports a complete geometry without pretending missing elevation is known', (entry) => {
    const parsed = parseRouteFile(readFileSync(`${fixtureDirectory}/${entry.file}`, 'utf8'), entry.file);
    expect(parsed.format).toBe(entry.format);
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0].points).toHaveLength(entry.observed.point_count);
    expect(parsed.landmarks).toHaveLength(entry.observed.landmark_count);
    expect(parsed.routes[0].points.filter((value) => value.elevation === null)).toHaveLength(entry.observed.missing_elevation_count);
    const reference = buildReference(parsed.routes[0]);
    const stations = createStations(reference, parsed.landmarks).map((station) => ({ ...station, confirmed: true }));
    const result = processRoute(reference, stations, { ...options, elevationMode: 'omit' }, identity);
    expect(result.issues.filter((value) => value.severity === 'error')).toEqual([]);
    expect(result.route).not.toBeNull();
    expect(result.route!.elev).toBeUndefined();
    expect(result.route!.elevationInfo).toBeUndefined();
    expect(result.route!.geom[0].sDm).toBe(0);
    expect(result.route!.geom.at(-1)!.sDm).toBe(quantize(reference.totalM * 10));
    expect(result.route!.geom.every((value, index, values) => index === 0 || value.sDm > values[index - 1].sDm)).toBe(true);
    expect(result.route!.geom.every((value, index, values) => index === 0 || value.latE7 !== values[index - 1].latE7 || value.lonE7 !== values[index - 1].lonE7)).toBe(true);
    const bytes = encodeRte(result.route!);
    expect(decodeRte(bytes).totalSDm).toBe(result.route!.totalSDm);
    expect(encodeRte(decodeRte(bytes))).toEqual(bytes);
  });

  it('keeps namespaced GPX segments and routes separate', () => {
    const parsed = parseRouteFile('<g:gpx xmlns:g="urn:gpx"><g:trk><g:name>A</g:name><g:trkseg><g:trkpt lat="0" lon="0"/><g:trkpt lat="0" lon="1"/></g:trkseg><g:trkseg><g:trkpt lat="0" lon="5"/><g:trkpt lat="0" lon="6"/></g:trkseg></g:trk><g:rte><g:rtept lat="0" lon="8"/><g:rtept lat="0" lon="9"/></g:rte></g:gpx>', 'segments.gpx');
    expect(parsed.routes).toHaveLength(3);
    expect(parsed.routes.map((route) => route.points.length)).toEqual([2, 2, 2]);
    expect(parsed.warnings.some((value) => value.includes('never automatically joined'))).toBe(true);
  });

  it('accepts standard XML entities and never treats labels as markup', () => {
    const parsed = parseRouteFile('<gpx><trk><name>A &amp; &lt;B&gt;</name><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0" lon="1"/></trkseg></trk></gpx>', 'x.gpx');
    expect(parsed.routes[0].name).toBe('A & <B>');
  });

  it.each([
    '<!DOCTYPE gpx [<!ENTITY evil SYSTEM "file:///etc/passwd">]><gpx/>',
    '<gpx><trk>&unknown;</trk></gpx>',
    '<gpx><trk></gpx>',
    '<gpx/><kml/>',
    '<gpx><trk><trkseg><trkpt lat="NaN" lon="0"/><trkpt lat="0" lon="1"/></trkseg></trk></gpx>',
    '<gpx><trk><trkseg><trkpt lat="91" lon="0"/><trkpt lat="0" lon="1"/></trkseg></trk></gpx>',
    '<kml><Placemark><LineString><coordinates>1,2,3,4 2,3,4</coordinates></LineString></Placemark></kml>',
  ])('rejects hostile or malformed input', (xml) => expect(() => parseRouteFile(xml, 'bad.xml')).toThrow());

  it('enforces nesting and byte budgets', () => {
    expect(() => parseRouteFile('<gpx>' + '<x>'.repeat(70) + '</x>'.repeat(70) + '</gpx>', 'deep.gpx')).toThrow('64');
    expect(() => parseRouteFile('x'.repeat(IMPORT_LIMITS.maxBytes + 1), 'big.gpx')).toThrow('20 MiB');
  });
});

describe('reference distance and station events', () => {
  it('keeps nonadjacent visits and makes contradictory duplicate height unavailable', () => {
    const reference = buildReference(source([point(0, 0, 10), point(0, 0, 20), point(0, 0, 10), point(0, 0.01, 15), point(0, 0, 10)]));
    expect(reference.points).toHaveLength(3);
    expect(reference.points[0].elevation).toBeNull();
    expect(reference.isClosed).toBe(true);
    expect(reference.issues.some((value) => value.code === 'ELEVATION_CONFLICT')).toBe(true);
    const result = processRoute(reference, createStations(reference, []), options, identity);
    expect(result.route).toBeNull();
    expect(result.issues.some((value) => value.code === 'INCOMPLETE_ELEVATION')).toBe(true);
  });

  it('reverses height accumulation and preserves the reference axis after geometry simplification', () => {
    const route = source([point(0, 0, 0), point(0, 0.0001, 10), point(0.0001, 0.0002, 20), point(0, 0.0003, 30)]);
    const reference = buildReference(route);
    const reversed = buildReference(route, { reverse: true });
    expect(reversed.totalM).toBeCloseTo(reference.totalM, 8);
    expect(reversed.points[0].sourceIndex).toBe(3);
    const forward = processRoute(reference, createStations(reference, []), { ...options, geometryToleranceM: 100 }, identity).route!;
    const backward = processRoute(reversed, createStations(reversed, []), options, identity).route!;
    expect(forward.totalSDm).toBe(quantize(reference.totalM * 10));
    expect(forward.elev!.at(-1)!.upDm).toBe(300);
    expect(forward.elev!.at(-1)!.downDm).toBe(0);
    expect(backward.elev!.at(-1)!.downDm).toBe(300);
    expect(backward.elev!.at(-1)!.upDm).toBe(0);
  });

  it('rotates a closed route and retains original indices without an implicit extra edge', () => {
    const route = source([point(0, 0), point(0, 0.001), point(0.001, 0.001), point(0, 0)]);
    const reference = buildReference(route, { startIndex: 1 });
    expect(reference.points[0].sourceIndex).toBe(1);
    expect(reference.points.at(-1)!.sourceIndex).toBe(1);
    expect(reference.totalM).toBeCloseTo(buildReference(route).totalM, 8);
    expect(() => buildReference(source(route.points.slice(0, -1)), { startIndex: 1 })).toThrow('closed');
    expect(buildReference(route).points.at(-1)!.sourceIndex).toBe(0);
  });

  it('does not silently discard contradictory closure elevations when rotating a loop', () => {
    const route = source([point(0, 0, 10), point(0, 0.001, 20), point(0.001, 0.001, 30), point(0, 0, 15)]);
    const reference = buildReference(route, { startIndex: 1 });
    expect(reference.points.find((value) => value.lat === 0 && value.lon === 0)!.elevation).toBeNull();
    expect(reference.issues.some((value) => value.code === 'ELEVATION_CONFLICT')).toBe(true);
    expect(processRoute(reference, createStations(reference, []), options, identity).route).toBeNull();
  });

  it('represents shared start and finish as two events without duplicating named endpoint POIs', () => {
    const reference = buildReference(source([point(0, 0), point(0, 0.001), point(0, 0)]));
    const stations = createStations(reference, ['起点', '终点', '起终点-广场'].map((name, index) => ({ id: String(index), name, lat: 0, lon: 0 })));
    expect(stations).toHaveLength(2);
    expect(stations.map((station) => station.kind)).toEqual([0, 1]);
    expect(stations[1].s).toBe(reference.totalM);
    expect(stations[0].id).not.toBe(stations[1].id);
  });

  it('orders checkpoints by along-route distance rather than checkpoint number', () => {
    const reference = buildReference(source([point(0, 0), point(0, 0.01)]));
    const stations = createStations(reference, [{ id: '1', name: 'CP1', lat: 0, lon: 0.008 }, { id: '9', name: 'CP9', lat: 0, lon: 0.002 }]);
    expect(stations.map((station) => station.name)).toEqual(['Start', 'CP9', 'CP1', 'Finish']);
  });

  it('reuses imported endpoints after reversing an open route', () => {
    const reference = buildReference(source([point(0, 0), point(0, 0.001)]), { reverse: true });
    const stations = createStations(reference, [{ id: 'start', name: 'Start plaza', lat: 0, lon: 0 }, { id: 'finish', name: 'Finish hill', lat: 0, lon: 0.001 }]);
    expect(stations).toHaveLength(2);
    expect(stations[0].name).toBe('Start · Finish hill');
    expect(stations[1].name).toBe('Finish · Start plaza');
    expect(stations.map((value) => value.kind)).toEqual([0, 1]);
  });

  it('offers repeated visits at a crossing and gates export until confirmed', () => {
    const reference = buildReference(source([point(0, 0), point(0, 0.001), point(0.001, 0.001), point(0, 0.001), point(0, 0.002)]));
    const landmark = { id: 'cp', name: 'CP1', lat: 0, lon: 0.001 };
    const candidates = matchLandmark(reference, landmark);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].s).not.toBe(candidates[1].s);
    const result = processRoute(reference, createStations(reference, [landmark]), options, identity);
    expect(result.route).toBeNull();
    expect(result.issues.some((value) => value.code === 'STATION_UNCONFIRMED')).toBe(true);
  });

  it('uses the short route across the antimeridian and normalizes +180 E7', () => {
    const reference = buildReference(source([point(0, 179.999), point(0, -179.999)]));
    expect(reference.totalM).toBeCloseTo(222.39016, 3);
    expect(Math.abs(positionAt(reference, reference.totalM / 2).lon)).toBeCloseTo(180, 8);
    const endpoint = buildReference(source([point(0, 179.999), point(0, 180)]));
    const result = processRoute(endpoint, createStations(endpoint, []), options, identity);
    expect(result.route!.geom.at(-1)!.lonE7).toBe(-1_800_000_000);
    expect(() => positionAt(reference, -1)).toThrow();
    expect(() => positionAt(reference, reference.totalM + 1)).toThrow();
  });
});

describe('preprocessing, profile sampling, and quantization', () => {
  it('rounds ties away from zero', () => {
    expect([1.5, -1.5, 0.5, -0.5].map(quantize)).toEqual([2, -2, 1, -1]);
  });

  it('preserves exact stage boundary nodes in GEOM and ELEV and computes stage extrema', () => {
    const reference = buildReference(source([point(0, 0, 10), point(0, 0.001, 20), point(0, 0.002, -5)]));
    const stations = createStations(reference, [{ id: 'cp', name: 'CP1', lat: 0, lon: 0.001 }]);
    const result = processRoute(reference, stations, { ...options, elevationIntervalM: 17 }, identity);
    expect(result.route).not.toBeNull();
    const route = result.route!;
    for (const station of route.stations.filter((value) => value.stageBoundary)) {
      expect(route.geom.some((node) => node.sDm === station.sDm)).toBe(true);
      expect(route.elev!.some((node) => node.sDm === station.sDm)).toBe(true);
    }
    for (let index = 1; index < route.elev!.length; index++) {
      const node = route.elev![index];
      const previous = route.elev![index - 1];
      expect(node.upDm).toBe(previous.upDm + Math.max(0, node.hDm - previous.hDm));
      expect(node.downDm).toBe(previous.downDm + Math.max(0, previous.hDm - node.hDm));
    }
    route.stages!.forEach((stage, index) => {
      const from = route.stations[index].sDm;
      const to = route.stations[index + 1].sDm;
      const heights = route.elev!.filter((node) => node.sDm >= from && node.sDm <= to).map((node) => node.hDm);
      expect(stage.minHDm).toBe(Math.min(...heights));
      expect(stage.maxHDm).toBe(Math.max(...heights));
    });
    expect(decodeRte(encodeRte(route)).elev).toEqual(route.elev);
  });

  it('applies smoothing to the calculation profile before quantized cumulative totals', () => {
    const reference = buildReference(source([point(0, 0, 0), point(0, 0.001, 100), point(0, 0.002, 0)]));
    const stations = createStations(reference, []);
    const raw = processRoute(reference, stations, options, identity).route!;
    const smooth = processRoute(reference, stations, { ...options, smoothingWindowM: 100 }, identity).route!;
    expect(smooth.elev!.at(-1)!.upDm).toBeLessThan(raw.elev!.at(-1)!.upDm);
    expect(smooth.elev!.at(-1)!.downDm).toBeLessThan(raw.elev!.at(-1)!.downDm);
    const end = smooth.elev!.at(-1)!;
    expect(end.upDm - end.downDm).toBe(end.hDm - smooth.elev![0].hDm);
    expect(decodeRte(encodeRte(smooth)).elev).toEqual(smooth.elev);
  });

  it('only repairs explicitly requested short interior gaps and records filled provenance', () => {
    const reference = buildReference(source([point(0, 0, 0), point(0, 0.0001, null), point(0, 0.0002, 20)]));
    const stations = createStations(reference, []);
    expect(processRoute(reference, stations, options, identity).route).toBeNull();
    const result = processRoute(reference, stations, { ...options, elevationMode: 'interpolate' }, identity);
    expect(result.route!.elevationInfo!.containsFilledValues).toBe(true);
    expect(result.route!.elev!.at(-1)!.upDm).toBe(200);
    expect(MAX_INTERPOLATION_GAP_M).toBe(100);
  });

  it.each([
    [point(0, 0, null), point(0, 0.0001, 10)],
    [point(0, 0, 0), point(0, 0.0001, null)],
    [point(0, 0, 0), point(0, 0.001, null), point(0, 0.002, 20)],
  ])('never extrapolates an endpoint or bridges a long unknown gap', (...points: SourcePoint[]) => {
    const reference = buildReference(source(points));
    const result = processRoute(reference, createStations(reference, []), { ...options, elevationMode: 'interpolate' }, identity);
    expect(result.route).toBeNull();
    expect(result.issues.some((value) => value.code === 'INCOMPLETE_ELEVATION')).toBe(true);
  });

  it('requires explicit KML elevation acceptance and keeps datum unknown', () => {
    const parsed = parseRouteFile('<kml><Placemark><LineString><coordinates>0,0,10 0.001,0,20</coordinates></LineString></Placemark></kml>', 'x.kml');
    const reference = buildReference(parsed.routes[0]);
    const stations = createStations(reference, []);
    expect(processRoute(reference, stations, options, identity).route).toBeNull();
    const result = processRoute(reference, stations, { ...options, acceptUncertainElevation: true }, identity);
    expect(result.route!.elevationInfo!.verticalDatum).toBe(0);
    expect(result.route!.elevationInfo!.quality).toBe(1);
  });

  it('bounds simplified edge length while preserving total progress', () => {
    const reference = buildReference(source([point(0, 0), point(0, 0.02)]));
    const route = processRoute(reference, createStations(reference, []), { ...options, geometryToleranceM: 1000 }, identity).route!;
    expect(route.totalSDm).toBe(quantize(reference.totalM * 10));
    route.geom.slice(1).forEach((node, index) => expect((node.sDm - route.geom[index].sDm) / 10).toBeLessThanOrEqual(MAX_GEOMETRY_EDGE_M + 0.1));
  });

  it('resolves dense distance collisions and rejects indistinguishable boundary collisions', () => {
    const reference = buildReference(source([point(0, 0), point(0, 0.000000001), point(0, 0.000000002), point(0, 0.00001)]));
    const stations = createStations(reference, []);
    expect(processRoute(reference, stations, options, identity).route).not.toBeNull();
    const extra = { ...stations[0], id: 3, name: 'Too close', kind: 2 as const, s: 0.01 };
    const result = processRoute(reference, [...stations, extra], options, identity);
    expect(result.route).toBeNull();
    expect(result.issues.some((value) => value.code === 'BOUNDARY_COLLISION')).toBe(true);
  });

  it('does not replace the measured distance axis with simplified chord distance', () => {
    const reference = buildReference(source([point(0, 0), point(0.00002, 0.0001), point(0, 0.0002)]));
    const chord = distanceM(reference.points[0], reference.points.at(-1)!);
    expect(reference.totalM).toBeGreaterThan(chord);
    const route = processRoute(reference, createStations(reference, []), { ...options, geometryToleranceM: 100 }, identity).route!;
    expect(route.geom).toHaveLength(2);
    expect(route.totalSDm).toBe(quantize(reference.totalM * 10));
  });

  it('applies UTF-8 byte limits instead of character count', () => {
    const reference = buildReference(source([point(0, 0), point(0, 0.001)]));
    const result = processRoute(reference, createStations(reference, []), options, { ...identity, name: '路'.repeat(33) });
    expect(result.route).toBeNull();
    expect(result.issues.some((value) => value.code === 'ROUTE_NAME_INVALID')).toBe(true);
  });
});

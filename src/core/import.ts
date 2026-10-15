import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ImportedFile, SourceLandmark, SourcePoint, SourceRoute } from './types';

/** Initial browser budgets; these are product limits, not RTE format limits. */
export const IMPORT_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxPoints: 200_000,
  maxRoutes: 256,
  maxLandmarks: 4096,
});

type XmlObject = Record<string, unknown>;
const object = (value: unknown): XmlObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as XmlObject : {};
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : text(object(value)['#text'] ?? '');

/** XML text is data. Plain text is kept for labels; it is never interpreted as HTML. */
export function cleanLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().normalize('NFC');
}

function finiteNumber(value: unknown, context: string): number {
  const string = text(value).trim();
  if (!string || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(string)) throw new Error(`${context} is not a valid number.`);
  const result = Number(string);
  if (!Number.isFinite(result)) throw new Error(`${context} is outside the finite number range.`);
  return result;
}

function coordinate(lat: unknown, lon: unknown, elevation?: unknown): SourcePoint {
  const latitude = finiteNumber(lat, 'Latitude');
  const longitude = finiteNumber(lon, 'Longitude');
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('Latitude or longitude is outside the WGS84 range.');
  return { lat: latitude, lon: longitude, elevation: elevation === undefined || text(elevation).trim() === '' ? null : finiteNumber(elevation, 'Elevation') };
}

/** Each continuous source segment remains independently selectable. Segments are never joined. */
export function parseRouteFile(xml: string, fileName: string): ImportedFile {
  if (new TextEncoder().encode(xml).byteLength > IMPORT_LIMITS.maxBytes) throw new Error('The file exceeds 20 MiB. Split the route before importing.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('XML DOCTYPE and entity declarations are not supported.');
  // Reject unknown entity references even with entity expansion disabled in the parser.
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, ''))) throw new Error('The XML contains an unsupported entity reference.');
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) throw new Error(`Invalid XML: ${validation.err.msg}`);
  // Limit nesting before building an object tree, including files without coordinates.
  let depth = 0;
  let tags = 0;
  const withoutData = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of withoutData.matchAll(/<\/?[A-Za-z_][^>]*>/g)) {
    if (++tags > 1_500_000) throw new Error('The XML contains too many elements.');
    if (match[0].startsWith('</')) depth--;
    else if (!match[0].endsWith('/>') && ++depth > 64) throw new Error('XML nesting exceeds 64 levels.');
  }
  const root = object(new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true,
    parseTagValue: false, parseAttributeValue: false, trimValues: false,
    processEntities: true, htmlEntities: false,
  }).parse(xml));
  const roots = Object.keys(root).filter((key) => !key.startsWith('?'));
  if (roots.length !== 1 || Array.isArray(root[roots[0]])) throw new Error('XML must have exactly one root element.');
  const format = root.gpx !== undefined ? 'gpx' : root.kml !== undefined ? 'kml' : null;
  if (!format) throw new Error('Only files with a gpx or kml root element are supported.');
  const routes: SourceRoute[] = [];
  const landmarks: SourceLandmark[] = [];
  const warnings: string[] = [];
  let pointCount = 0;
  const fallbackName = cleanLabel(fileName.replace(/\.[^.]+$/, '')) || 'Unnamed route';
  const addRoute = (points: SourcePoint[], name: string, uncertain: boolean) => {
    if (routes.length >= IMPORT_LIMITS.maxRoutes) throw new Error('The file contains more than 256 route segments.');
    if (points.length < 2) { warnings.push(`“${name}” has fewer than two points and was skipped.`); return; }
    routes.push({ id: `route-${routes.length + 1}`, name, points, elevationDatum: 0, elevationUncertain: uncertain });
  };
  const countPoint = (point: SourcePoint) => {
    if (++pointCount > IMPORT_LIMITS.maxPoints) throw new Error('The file contains more than 200,000 route points.');
    return point;
  };
  const addLandmark = (point: SourcePoint, name: string) => {
    if (landmarks.length >= IMPORT_LIMITS.maxLandmarks) throw new Error('The file contains more than 4,096 landmarks.');
    landmarks.push({ id: `landmark-${landmarks.length + 1}`, name: cleanLabel(name) || `Station ${landmarks.length + 1}`, lat: point.lat, lon: point.lon });
  };
  if (format === 'gpx') {
    const gpx = object(root.gpx);
    for (const entry of list(gpx.wpt)) {
      const point = object(entry);
      addLandmark(coordinate(point['@_lat'], point['@_lon']), text(point.name));
    }
    for (const [index, entry] of list(gpx.trk).entries()) {
      const track = object(entry);
      const name = cleanLabel(text(track.name)) || `${fallbackName}${list(gpx.trk).length > 1 ? ` · ${index + 1}` : ''}`;
      const segments = list(track.trkseg);
      for (const [segmentIndex, segment] of segments.entries()) {
        const points = list(object(segment).trkpt).map((entry) => { const point = object(entry); return countPoint(coordinate(point['@_lat'], point['@_lon'], point.ele)); });
        addRoute(points, `${name}${segments.length > 1 ? ` · Segment ${segmentIndex + 1}` : ''}`, false);
      }
    }
    for (const entry of list(gpx.rte)) {
      const route = object(entry);
      const points = list(route.rtept).map((entry) => { const point = object(entry); return countPoint(coordinate(point['@_lat'], point['@_lon'], point.ele)); });
      addRoute(points, cleanLabel(text(route.name)) || fallbackName, false);
    }
  } else {
    const coordinates = (value: unknown, isRoute: boolean): SourcePoint[] => text(value).trim().split(/\s+/).filter(Boolean).map((tuple) => {
      const fields = tuple.split(',');
      if (fields.length < 2 || fields.length > 3) throw new Error('KML coordinates must contain longitude, latitude, and optional elevation.');
      const point = coordinate(fields[1], fields[0], fields[2]);
      return isRoute ? countPoint(point) : point;
    });
    const walk = (value: unknown, inheritedName: string) => {
      for (const entry of list(value)) {
        const node = object(entry);
        const name = cleanLabel(text(node.name)) || inheritedName;
        for (const lineEntry of list(node.LineString)) {
          const line = object(lineEntry);
          // KML altitude modes describe rendering semantics and do not establish a terrain datum.
          addRoute(coordinates(line.coordinates, true), name, true);
        }
        for (const pointEntry of list(node.Point)) {
          const points = coordinates(object(pointEntry).coordinates, false);
          if (points.length !== 1) throw new Error('A KML Point must contain exactly one coordinate.');
          addLandmark(points[0], name);
        }
        for (const key of ['Document', 'Folder', 'Placemark', 'MultiGeometry']) if (node[key] !== undefined) walk(node[key], name);
      }
    };
    walk(root.kml, fallbackName);
    if (routes.some((route) => route.points.some((point) => point.elevation !== null))) warnings.push('KML altitude values are candidates. Confirm they represent ground elevation before using them; their vertical datum remains unknown.');
  }
  if (!routes.length) throw new Error('No continuous route segment with at least two points was found.');
  if (routes.length > 1) warnings.push(`Found ${routes.length} separate route segments. Select one to process; discontinuities are never automatically joined.`);
  return { fileName, format, routes, landmarks, warnings };
}

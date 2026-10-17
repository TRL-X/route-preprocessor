import { IMPORT_LIMITS, PROCESSING_LIMITS } from '../core/policy';
import { DRAFT_VERSION, type Draft } from './editor';

const UINT32_MAX = 0xffff_ffff;

function invalid(path: string, expected: string): never {
  throw new Error(`Invalid saved draft: ${path} ${expected}.`);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(path, 'must be an object');
  return value as Record<string, unknown>;
}
function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') invalid(path, 'must be text');
  if (value.length > IMPORT_LIMITS.maxBytes) invalid(path, 'exceeds the text budget');
}
function numeric(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number') invalid(path, 'must be a number');
}
function finite(value: unknown, path: string, min = -Infinity, max = Infinity): number {
  numeric(value, path);
  if (!Number.isFinite(value) || value < min || value > max)
    invalid(path, `must be finite and in ${min}..${max}`);
  return value;
}
function integer(value: unknown, path: string, min: number, max: number): number {
  const result = finite(value, path, min, max);
  if (!Number.isInteger(result)) invalid(path, 'must be an integer');
  return result;
}
function boolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean');
}
function choice(value: unknown, path: string, choices: readonly unknown[]): void {
  if (!choices.includes(value)) invalid(path, `must be one of ${choices.join(', ')}`);
}
function array(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    invalid(path, `must contain ${min}..${max} entries`);
  return value;
}
function bytes(value: unknown, path: string, length: number): void {
  if (!(value instanceof Uint8Array) || value.length !== length)
    invalid(path, `must be a ${length}-byte Uint8Array`);
}
function coordinates(value: Record<string, unknown>, path: string): void {
  finite(value.lat, `${path}.lat`, -90, 90);
  finite(value.lon, `${path}.lon`, -180, 180);
}
function sourcePoint(value: unknown, path: string): Record<string, unknown> {
  const point = object(value, path);
  coordinates(point, path);
  if (point.elevation !== null) finite(point.elevation, `${path}.elevation`);
  return point;
}
function diagnostics(value: unknown, path: string, processing: boolean): void {
  for (const [index, entry] of array(value, path, 0, IMPORT_LIMITS.maxXmlElements).entries()) {
    const at = `${path}[${index}]`;
    const issue = object(entry, at);
    text(issue.code, `${at}.code`);
    if (issue.message !== undefined) text(issue.message, `${at}.message`);
    if (issue.params !== undefined) {
      for (const [key, parameter] of Object.entries(object(issue.params, `${at}.params`))) {
        if (typeof parameter !== 'string' && typeof parameter !== 'number')
          invalid(`${at}.params.${key}`, 'must be text or a number');
      }
    }
    if (processing) {
      choice(issue.severity, `${at}.severity`, ['warning', 'error']);
      if (issue.s !== undefined) finite(issue.s, `${at}.s`, 0);
    }
  }
}

function validateEditor(value: unknown): void {
  const editor = object(value, 'editor');
  text(editor.name, 'editor.name');
  bytes(editor.routeId, 'editor.routeId', 16);
  if (!(editor.routeId as Uint8Array).some(Boolean))
    invalid('editor.routeId', 'must not be all zero');
  bytes(editor.inputSha256, 'editor.inputSha256', 32);
  boolean(editor.reverse, 'editor.reverse');

  const file = object(editor.file, 'editor.file');
  text(file.fileName, 'editor.file.fileName');
  choice(file.format, 'editor.file.format', ['gpx', 'kml']);
  const routes = array(file.routes, 'editor.file.routes', 1, IMPORT_LIMITS.maxRoutes);
  let pointCount = 0;
  for (const [index, entry] of routes.entries()) {
    const at = `editor.file.routes[${index}]`;
    const route = object(entry, at);
    text(route.id, `${at}.id`);
    text(route.name, `${at}.name`);
    integer(route.elevationDatum, `${at}.elevationDatum`, 0, 3);
    boolean(route.elevationUncertain, `${at}.elevationUncertain`);
    const points = array(route.points, `${at}.points`, 2, IMPORT_LIMITS.maxPoints);
    pointCount += points.length;
    if (pointCount > IMPORT_LIMITS.maxPoints)
      invalid('editor.file.routes', 'exceeds the source point budget');
    for (const [index, point] of points.entries()) sourcePoint(point, `${at}.points[${index}]`);
  }
  for (const [index, entry] of array(
    file.landmarks,
    'editor.file.landmarks',
    0,
    IMPORT_LIMITS.maxLandmarks,
  ).entries()) {
    const at = `editor.file.landmarks[${index}]`;
    const landmark = object(entry, at);
    text(landmark.id, `${at}.id`);
    text(landmark.name, `${at}.name`);
    coordinates(landmark, at);
  }
  diagnostics(file.warnings, 'editor.file.warnings', false);

  const sourceIndex = integer(editor.sourceIndex, 'editor.sourceIndex', 0, routes.length - 1);
  const source = routes[sourceIndex] as Record<string, unknown>;
  const sourcePoints = source.points as Record<string, unknown>[];
  const first = sourcePoints[0];
  const last = sourcePoints.at(-1)!;
  const closed =
    sourcePoints.length > 2 &&
    first.lat === last.lat &&
    ((first.lon as number) - (last.lon as number)) % 360 === 0;
  integer(editor.startIndex, 'editor.startIndex', 0, closed ? sourcePoints.length - 2 : 0);

  const reference = object(editor.reference, 'editor.reference');
  boolean(reference.isClosed, 'editor.reference.isClosed');
  if (reference.isClosed !== closed)
    invalid('editor.reference.isClosed', 'must match the selected source route');
  integer(reference.elevationDatum, 'editor.reference.elevationDatum', 0, 3);
  boolean(reference.elevationUncertain, 'editor.reference.elevationUncertain');
  const totalM = finite(reference.totalM, 'editor.reference.totalM', 0);
  const referencePoints = array(
    reference.points,
    'editor.reference.points',
    1,
    sourcePoints.length,
  );
  let previousS = 0;
  for (const [index, entry] of referencePoints.entries()) {
    const at = `editor.reference.points[${index}]`;
    const point = sourcePoint(entry, at);
    previousS = finite(point.s, `${at}.s`, previousS, totalM);
    if (index === 0 && previousS !== 0) invalid(`${at}.s`, 'must start at zero');
    if (point.sourceIndex !== undefined)
      integer(point.sourceIndex, `${at}.sourceIndex`, 0, sourcePoints.length - 1);
  }
  if (previousS !== totalM)
    invalid('editor.reference.totalM', 'must equal the final reference distance');
  diagnostics(reference.issues, 'editor.reference.issues', true);

  const options = object(editor.options, 'editor.options');
  // Editable numbers may be unfinished or outside processing ranges. Core reports those errors.
  for (const key of ['geometryToleranceM', 'elevationIntervalM', 'smoothingWindowM'])
    numeric(options[key], `editor.options.${key}`);
  choice(options.elevationMode, 'editor.options.elevationMode', ['source', 'interpolate']);
  boolean(options.acceptUncertainElevation, 'editor.options.acceptUncertainElevation');
  const minimumStations = referencePoints.length < 2 ? 0 : 2;
  const stationIds = new Set<number>();
  for (const [index, entry] of array(
    editor.stations,
    'editor.stations',
    minimumStations,
    IMPORT_LIMITS.maxPoints,
  ).entries()) {
    const at = `editor.stations[${index}]`;
    const station = object(entry, at);
    const id = integer(station.id, `${at}.id`, 1, UINT32_MAX);
    if (stationIds.has(id)) invalid(`${at}.id`, 'must be unique');
    stationIds.add(id);
    text(station.name, `${at}.name`);
    text(station.shortLabel, `${at}.shortLabel`);
    integer(station.kind, `${at}.kind`, 0, 4);
    boolean(station.stageBoundary, `${at}.stageBoundary`);
    boolean(station.confirmed, `${at}.confirmed`);
    for (const key of ['s', 'lat', 'lon']) numeric(station[key], `${at}.${key}`);
    for (const [index, entry] of array(
      station.candidates,
      `${at}.candidates`,
      0,
      PROCESSING_LIMITS.maxMatchCandidates,
    ).entries()) {
      const atCandidate = `${at}.candidates[${index}]`;
      const candidate = object(entry, atCandidate);
      coordinates(candidate, atCandidate);
      finite(candidate.s, `${atCandidate}.s`, 0, totalM);
      finite(candidate.distanceM, `${atCandidate}.distanceM`, 0);
    }
  }
  if (editor.declinationMode !== undefined)
    choice(editor.declinationMode, 'editor.declinationMode', ['auto', 'manual', 'omit']);
  if (editor.declinationQueryDate !== undefined)
    text(editor.declinationQueryDate, 'editor.declinationQueryDate');
  if (editor.magneticDeclination !== undefined) {
    const info = object(editor.magneticDeclination, 'editor.magneticDeclination');
    for (const key of ['declinationCdeg', 'referenceLatE7', 'referenceLonE7'])
      numeric(info[key], `editor.magneticDeclination.${key}`);
    for (const key of ['referenceDate', 'source'])
      text(info[key], `editor.magneticDeclination.${key}`);
    for (const key of ['validFrom', 'validUntil'])
      if (info[key] !== undefined) text(info[key], `editor.magneticDeclination.${key}`);
  }
}

/** Versions 1 and 2 share one migration; unknown versions require explicit support. */
export function parseDraft(value: unknown): Draft {
  const stored = object(value, 'draft');
  if (![1, 2, DRAFT_VERSION].includes(stored.version as number)) {
    throw new Error(
      `Unsupported saved draft version ${String(stored.version)}. Supported versions: 1, 2, ${DRAFT_VERSION}.`,
    );
  }
  let draft = stored;
  if (stored.version !== DRAFT_VERSION) {
    const editor = object(stored.editor, 'editor');
    const file = object(editor.file, 'editor.file');
    const warnings = array(
      file.warnings,
      'editor.file.warnings',
      0,
      IMPORT_LIMITS.maxXmlElements,
    ).map((warning) =>
      typeof warning === 'string' ? { code: 'import', message: warning } : warning,
    );
    const options = object(editor.options, 'editor.options');
    const magneticDeclination =
      editor.magneticDeclination === undefined
        ? undefined
        : { ...object(editor.magneticDeclination, 'editor.magneticDeclination') };
    if (magneticDeclination) delete magneticDeclination.referenceHeightDm;
    draft = {
      ...stored,
      version: DRAFT_VERSION,
      editor: {
        ...editor,
        file: { ...file, warnings },
        options: {
          ...options,
          elevationMode: options.elevationMode === 'omit' ? 'source' : options.elevationMode,
        },
        ...(magneticDeclination ? { magneticDeclination } : {}),
      },
    };
  }
  validateEditor(draft.editor);
  finite(draft.savedAt, 'savedAt', 0);
  const ledger = object(draft.ledger, 'ledger');
  for (const [key, entry] of Object.entries(ledger))
    integer(object(entry, `ledger.${key}`).revision, `ledger.${key}.revision`, 1, UINT32_MAX);
  return draft as unknown as Draft;
}

import { utcToday } from '../core/declination';
import { IMPORT_LIMITS, PROCESSING_DEFAULTS } from '../core/policy';
import type {
  DraftStation,
  ImportedFile,
  ProcessingIssue,
  ReferenceRoute,
  RouteData,
} from '../core/types';
import { reserveExportRevision, RevisionExhaustedError } from './drafts';
import type { Editor, Ledger } from './editor';
import { runWorkerTask } from './worker-client';

export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const isCancelled = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

export interface ExportedRoute {
  filename: string;
  bytes: number;
  revision: number;
  routeId: string;
}
export interface PreparedExport {
  bytes: Uint8Array;
  exported: ExportedRoute;
  ledger: Ledger;
  persisted: boolean;
}

export function routeFilename(name: string): string {
  return (
    (name
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .slice(0, 80) || 'route') + '.rte'
  );
}

export async function importRouteFile(file: File, signal: AbortSignal): Promise<Editor> {
  if (!/\.(gpx|kml)$/i.test(file.name)) throw new Error('app.unsupportedFileType');
  if (file.size > IMPORT_LIMITS.maxBytes) throw new Error('app.fileTooLarge');
  signal.throwIfAborted();
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  signal.throwIfAborted();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const data = await runWorkerTask<{
    file: ImportedFile;
    reference: ReferenceRoute;
    stations: DraftStation[];
  }>({ type: 'import', text, fileName: file.name }, signal);
  signal.throwIfAborted();
  return {
    ...data,
    declinationMode: 'auto',
    declinationQueryDate: utcToday(),
    options: { ...PROCESSING_DEFAULTS },
    name: data.file.routes[0].name || file.name.replace(/\.(gpx|kml)$/i, ''),
    routeId: crypto.getRandomValues(new Uint8Array(16)),
    inputSha256: hash,
    sourceIndex: 0,
    reverse: false,
    startIndex: 0,
  };
}

export async function rebuildRoute(
  editor: Editor,
  sourceIndex: number,
  reverse: boolean,
  startIndex: number,
  signal: AbortSignal,
): Promise<Editor> {
  const data = await runWorkerTask<{ reference: ReferenceRoute; stations: DraftStation[] }>(
    {
      type: 'reference',
      source: editor.file.routes[sourceIndex],
      reverse,
      startIndex,
      landmarks: editor.file.landmarks,
    },
    signal,
  );
  signal.throwIfAborted();
  return { ...editor, ...data, sourceIndex, reverse, startIndex };
}

export async function prepareRouteExport(
  editor: Editor,
  route: RouteData,
  ledger: Ledger,
  signal: AbortSignal,
): Promise<PreparedExport> {
  const encode = async (data: RouteData) => {
    const bytes = await runWorkerTask<Uint8Array>({ type: 'export', route: data }, signal);
    signal.throwIfAborted();
    return bytes;
  };
  const key = hex(editor.routeId);
  const canonical = await encode({ ...route, revision: 1 });
  const hash = hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(canonical).buffer)),
  );
  signal.throwIfAborted();
  let revision: number;
  let outputId = editor.routeId;
  let persisted = true;
  try {
    revision = await reserveExportRevision(key, hash, ledger[key]?.revision ?? 0);
  } catch (error) {
    if (error instanceof RevisionExhaustedError) throw error;
    // A fresh identity prevents revision reuse when storage is unavailable.
    persisted = false;
    revision = 1;
    outputId = crypto.getRandomValues(new Uint8Array(16));
  }
  signal.throwIfAborted();
  const bytes =
    revision === 1 && persisted
      ? canonical
      : await encode({ ...route, routeId: outputId, revision });
  signal.throwIfAborted();
  const filename = routeFilename(editor.name);
  return {
    bytes,
    exported: { filename, bytes: bytes.length, revision, routeId: hex(outputId) },
    ledger: persisted ? { ...ledger, [key]: { revision } } : ledger,
    persisted,
  };
}

export function download(bytes: Uint8Array, filename: string, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function downloadQualityReport(
  editor: Editor,
  exported: ExportedRoute | null,
  revision: number,
  language: string,
  issues: ProcessingIssue[],
  message: (issue: ProcessingIssue) => string,
) {
  const report = {
    name: editor.name,
    source: editor.file.fileName,
    routeId: exported?.routeId ?? hex(editor.routeId),
    revision: exported?.revision ?? revision,
    parameters: editor.options,
    magneticDeclination: editor.magneticDeclination,
    totalDistanceM: editor.reference.totalM,
    reportLanguage: language,
    issues: issues.map((issue) => ({ ...issue, message: message(issue) })),
    stationCount: editor.stations.length,
    inputSha256: hex(editor.inputSha256),
  };
  download(
    new TextEncoder().encode(JSON.stringify(report, null, 2)),
    'route-quality-report.json',
    'application/json',
  );
}

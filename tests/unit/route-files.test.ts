import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRouteFilename,
  hex,
  importRouteFile,
  prepareRouteExport,
  rebuildRoute,
  routeFilename,
} from '../../src/app/route-files';
import { reserveExportRevision, RevisionExhaustedError } from '../../src/app/drafts';
import type { Editor } from '../../src/app/editor';
import { runWorkerTask } from '../../src/app/worker-client';
import { parseRouteFile } from '../../src/core/import';
import { PROCESSING_DEFAULTS } from '../../src/core/policy';
import { buildReference, createStations, processRoute } from '../../src/core/process';
import { decodeRte, encodeRte } from '../../src/core/rte';
import type { WorkerTask } from '../../src/workers/route.worker';

vi.mock('../../src/app/worker-client', () => ({ runWorkerTask: vi.fn() }));

const gpx =
  '<gpx><trk><name>Forest trail</name><trkseg><trkpt lat="0" lon="0"><ele>100</ele></trkpt><trkpt lat="0" lon="0.001"><ele>120</ele></trkpt></trkseg></trk></gpx>';

function fixture() {
  const file = parseRouteFile(gpx, 'forest.gpx');
  const reference = buildReference(file.routes[0]);
  const stations = createStations(reference, file.landmarks);
  const editor: Editor = {
    file,
    reference,
    stations,
    options: { ...PROCESSING_DEFAULTS },
    name: 'Forest trail',
    routeId: new Uint8Array(16).fill(7),
    inputSha256: new Uint8Array(32),
    sourceIndex: 0,
    reverse: false,
    startIndex: 0,
    declinationMode: 'omit',
  };
  const result = processRoute(reference, stations, editor.options, {
    routeId: editor.routeId,
    revision: 1,
    name: editor.name,
  });
  if (!result.route) throw new Error('The export fixture must be valid.');
  return { editor, route: result.route };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.mocked(runWorkerTask).mockImplementation(
    async <T>(task: WorkerTask, signal: AbortSignal): Promise<T> => {
      signal.throwIfAborted();
      if (task.type === 'export') {
        const bytes = encodeRte(task.route);
        decodeRte(bytes);
        return bytes as T;
      }
      if (task.type === 'import') {
        const file = parseRouteFile(task.text, task.fileName);
        const reference = buildReference(file.routes[0]);
        return { file, reference, stations: createStations(reference, file.landmarks) } as T;
      }
      if (task.type === 'reference') {
        const reference = buildReference(task.source, {
          reverse: task.reverse,
          startIndex: task.startIndex,
        });
        return { reference, stations: createStations(reference, task.landmarks) } as T;
      }
      throw new Error(`Unexpected worker task: ${task.type}`);
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('route file operations', () => {
  it('creates an eight-letter uppercase default filename from random bytes', () => {
    const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint8Array).set([0, 1, 2, 25, 26, 27, 254, 255]);
      return array;
    });
    expect(createRouteFilename()).toBe('ABCZABUV.RTE');
    expect(random).toHaveBeenCalledWith(expect.any(Uint8Array));
    random.mockRestore();
    expect(createRouteFilename()).toMatch(/^[A-Z]{8}\.RTE$/);
  });

  it.each([
    ['Forest trail', 'Forest trail.RTE'],
    ['  山路.rte  ', '山路.RTE'],
    ['my-route.RtE', 'my-route.RTE'],
    ['ABCDEFGH.RTE', 'ABCDEFGH.RTE'],
    ['a'.repeat(100), 'a'.repeat(100) + '.RTE'],
  ])('normalizes the custom filename %j to %j', (name, expected) => {
    expect(routeFilename(name)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    '.rte',
    '.',
    '..',
    '../forest',
    'a/b',
    'a\\b',
    'a:b',
    'a<b',
    'a>b',
    'a"b',
    'a|b',
    'a?b',
    'a*b',
    'a\u0000b',
    'a\nb',
    'a\u007fb',
    'a\u0085b',
  ])('rejects the invalid custom filename %j', (name) => {
    expect(() => routeFilename(name)).toThrow('app.invalidFilename');
  });

  it.each<{
    name: string;
    elevations: (number | null)[];
    mode: 'source' | 'interpolate';
    exportable: boolean;
    filled: boolean;
  }>([
    {
      name: 'complete positive heights',
      elevations: [100, 110, 120],
      mode: 'source',
      exportable: true,
      filled: false,
    },
    {
      name: 'complete zero and negative heights',
      elevations: [0, -10, 5],
      mode: 'source',
      exportable: true,
      filled: false,
    },
    {
      name: 'missing interior heights',
      elevations: [100, null, 120],
      mode: 'interpolate',
      exportable: true,
      filled: true,
    },
    {
      name: 'missing endpoint heights',
      elevations: [null, 110, 120],
      mode: 'interpolate',
      exportable: false,
      filled: false,
    },
    {
      name: 'missing whole-route heights',
      elevations: [null, null, null],
      mode: 'interpolate',
      exportable: false,
      filled: false,
    },
  ])(
    'selects the import elevation default for $name without relaxing validation',
    async ({ elevations, mode, exportable, filled }) => {
      const points = elevations
        .map(
          (elevation, index) =>
            `<trkpt lat="0" lon="${index * 0.001}">${elevation === null ? '' : `<ele>${elevation}</ele>`}</trkpt>`,
        )
        .join('');
      const editor = await importRouteFile(
        new File(
          [`<gpx><trk><name>Trail</name><trkseg>${points}</trkseg></trk></gpx>`],
          'trail.gpx',
        ),
        new AbortController().signal,
      );
      expect(editor.options.elevationMode).toBe(mode);
      const result = processRoute(editor.reference, editor.stations, editor.options, {
        routeId: editor.routeId,
        revision: 1,
        name: editor.name,
      });
      if (exportable) {
        expect(result.route?.elevationInfo.containsFilledValues).toBe(filled);
        expect(result.issues.some((issue) => issue.severity === 'error')).toBe(false);
      } else {
        expect(result.route).toBeNull();
        expect(result.issues).toContainEqual(
          expect.objectContaining({ code: 'INCOMPLETE_ELEVATION', severity: 'error' }),
        );
      }
    },
  );

  it('uses normalized missing heights when selecting the import default', async () => {
    const editor = await importRouteFile(
      new File(
        [
          '<gpx><trk><trkseg>' +
            '<trkpt lat="0" lon="0"><ele>100</ele></trkpt>' +
            '<trkpt lat="0" lon="0.001"><ele>110</ele></trkpt>' +
            '<trkpt lat="0" lon="0.001"><ele>120</ele></trkpt>' +
            '<trkpt lat="0" lon="0.002"><ele>130</ele></trkpt>' +
            '</trkseg></trk></gpx>',
        ],
        'conflict.gpx',
      ),
      new AbortController().signal,
    );
    expect(editor.file.routes[0].points.every((point) => point.elevation !== null)).toBe(true);
    expect(editor.reference.points.some((point) => point.elevation === null)).toBe(true);
    expect(editor.options.elevationMode).toBe('interpolate');
  });

  it.each(['source', 'interpolate'] as const)(
    'preserves an existing %s choice when rebuilding a route with missing heights',
    async (elevationMode) => {
      const { editor } = fixture();
      const file = parseRouteFile(
        '<gpx><trk><trkseg><trkpt lat="0" lon="0"><ele>100</ele></trkpt><trkpt lat="0" lon="0.001"/><trkpt lat="0" lon="0.002"><ele>120</ele></trkpt></trkseg></trk></gpx>',
        'gaps.gpx',
      );
      const previous = { ...editor, file, options: { ...editor.options, elevationMode } };
      const rebuilt = await rebuildRoute(previous, 0, true, 0, new AbortController().signal);
      expect(rebuilt.reference.points.some((point) => point.elevation === null)).toBe(true);
      expect(rebuilt.options).toBe(previous.options);
      expect(rebuilt.options.elevationMode).toBe(elevationMode);
    },
  );

  it('reuses identical export bytes and advances the revision after an edit', async () => {
    const { editor, route } = fixture();
    const signal = new AbortController().signal;
    const first = await prepareRouteExport(editor, route, {}, signal);
    expect(first.exported).toMatchObject({
      filename: expect.stringMatching(/^[A-Z]{8}\.RTE$/),
      revision: 1,
      routeId: hex(editor.routeId),
    });
    expect(decodeRte(first.bytes).stages).toEqual([
      { fromEventId: 1, toEventId: 2, minHDm: 1000, maxHDm: 1200 },
    ]);
    const repeated = await prepareRouteExport(editor, route, first.ledger, signal);
    expect(repeated.bytes).toEqual(first.bytes);
    const changed = await prepareRouteExport(
      { ...editor, name: 'Edited trail' },
      { ...route, name: 'Edited trail' },
      repeated.ledger,
      signal,
    );
    expect(decodeRte(changed.bytes)).toMatchObject({
      name: 'Edited trail',
      revision: 2,
      routeId: editor.routeId,
    });
  });

  it('uses custom filenames without changing route metadata, bytes or revisions', async () => {
    const { editor, route } = fixture();
    const signal = new AbortController().signal;
    const first = await prepareRouteExport(editor, route, {}, signal, 'Morning trail.rte');
    const renamed = await prepareRouteExport(editor, route, first.ledger, signal, '山路');
    expect(first.exported.filename).toBe('Morning trail.RTE');
    expect(renamed.exported.filename).toBe('山路.RTE');
    expect(renamed.bytes).toEqual(first.bytes);
    expect(renamed.exported.revision).toBe(first.exported.revision);
    expect(renamed.exported.routeId).toBe(first.exported.routeId);
    expect(decodeRte(renamed.bytes).name).toBe(editor.name);
  });

  it('rejects invalid filenames before encoding or reserving a revision', async () => {
    const { editor, route } = fixture();
    await expect(
      prepareRouteExport(editor, route, {}, new AbortController().signal, '../forest'),
    ).rejects.toThrow('app.invalidFilename');
    expect(runWorkerTask).not.toHaveBeenCalled();
    expect(await reserveExportRevision(hex(editor.routeId), 'next-export')).toBe(1);
  });

  it('reserves revisions above the restored draft ledger', async () => {
    const { editor, route } = fixture();
    const output = await prepareRouteExport(
      editor,
      route,
      { [hex(editor.routeId)]: { revision: 7 } },
      new AbortController().signal,
    );
    expect(decodeRte(output.bytes).revision).toBe(8);
    expect(output.ledger[hex(editor.routeId)]).toEqual({ revision: 8 });
  });

  it('uses a new identity when reservations cannot be persisted', async () => {
    const { editor, route } = fixture();
    const originalId = Uint8Array.from(editor.routeId);
    vi.stubGlobal('indexedDB', {
      open() {
        throw new DOMException('Storage unavailable', 'SecurityError');
      },
    });
    const first = await prepareRouteExport(editor, route, {}, new AbortController().signal);
    const second = await prepareRouteExport(editor, route, {}, new AbortController().signal);
    expect(first.persisted).toBe(false);
    expect(first.ledger).toEqual({});
    expect(first.exported.routeId).not.toBe(hex(originalId));
    expect(second.exported.routeId).not.toBe(first.exported.routeId);
    expect(decodeRte(first.bytes)).toMatchObject({ routeId: expect.any(Uint8Array), revision: 1 });
    expect(hex(decodeRte(first.bytes).routeId)).toBe(first.exported.routeId);
    expect(editor.routeId).toEqual(originalId);
  });

  it('does not treat revision exhaustion as a storage failure', async () => {
    const { editor, route } = fixture();
    await expect(
      prepareRouteExport(
        editor,
        route,
        { [hex(editor.routeId)]: { revision: 0xffffffff } },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RevisionExhaustedError);
  });

  it('cancels before reserving a revision when hashing is interrupted', async () => {
    const { editor, route } = fixture();
    const controller = new AbortController();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      const hash = await digest(...args);
      controller.abort();
      return hash;
    });
    await expect(prepareRouteExport(editor, route, {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(await reserveExportRevision(hex(editor.routeId), 'next-export')).toBe(1);
  });

  it('cancels an import during file reading without starting a worker', async () => {
    const file = new File([gpx], 'forest.gpx');
    const controller = new AbortController();
    const read = file.arrayBuffer.bind(file);
    vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
      const bytes = await read();
      controller.abort();
      return bytes;
    });
    await expect(importRouteFile(file, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(runWorkerTask).not.toHaveBeenCalled();
  });
});

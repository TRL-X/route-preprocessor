import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hex, importRouteFile, prepareRouteExport } from '../../src/app/route-files';
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
  it('reuses identical export bytes and advances the revision after an edit', async () => {
    const { editor, route } = fixture();
    const signal = new AbortController().signal;
    const first = await prepareRouteExport(editor, route, {}, signal);
    expect(first.exported).toMatchObject({
      filename: 'Forest trail.rte',
      revision: 1,
      routeId: hex(editor.routeId),
    });
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

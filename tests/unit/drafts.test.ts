import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadDraft,
  reserveExportRevision,
  RevisionExhaustedError,
  saveDraft,
} from '../../src/app/drafts';
import { DRAFT_VERSION, type Draft } from '../../src/app/editor';
import { parseDraft } from '../../src/app/draft-schema';
import { parseRouteFile } from '../../src/core/import';
import { buildReference, createStations } from '../../src/core/process';
import { IMPORT_LIMITS, PROCESSING_DEFAULTS, PROCESSING_LIMITS } from '../../src/core/policy';

const DB_NAME = 'trl-x-route-studio';
const MAX_REVISION = 0xffffffff;

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function openVersionOne(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putStoredDraft(db: IDBDatabase, draft: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite');
    transaction.objectStore('drafts').put(draft, 'current');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function putExportReservation(
  routeId: string,
  revision: number,
  contentHash: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts');
      if (!db.objectStoreNames.contains('exports')) db.createObjectStore('exports');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('exports', 'readwrite');
      transaction.objectStore('exports').put({ revision, contentHash }, routeId);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}

describe('transactional export revision reservations', () => {
  it('allocates different revisions for parallel exports with different content', async () => {
    const revisions = await Promise.all([
      reserveExportRevision('route-a', 'content-a'),
      reserveExportRevision('route-a', 'content-b'),
    ]);
    expect([...revisions].sort()).toEqual([1, 2]);
    const latestContent = revisions[0] === 2 ? 'content-a' : 'content-b';
    expect(await reserveExportRevision('route-a', latestContent)).toBe(2);
  });

  it('reuses the latest revision for identical parallel content', async () => {
    expect(
      await Promise.all(
        Array.from({ length: 8 }, () => reserveExportRevision('route-a', 'same-content')),
      ),
    ).toEqual(Array(8).fill(1));
    expect(await reserveExportRevision('route-a', 'same-content')).toBe(1);
  });

  it('allocates monotonically across multiple independent database connections', async () => {
    const revisions = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        reserveExportRevision('route-a', `content-${index}`),
      ),
    );
    expect([...revisions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it('keeps identities independent and never revives old revisions after undo', async () => {
    expect(await reserveExportRevision('route-a', 'original')).toBe(1);
    expect(await reserveExportRevision('route-b', 'original')).toBe(1);
    expect(await reserveExportRevision('route-a', 'changed')).toBe(2);
    expect(await reserveExportRevision('route-a', 'original')).toBe(3);
    expect(await reserveExportRevision('route-b', 'original')).toBe(1);
  });

  it('does not wrap an exhausted revision and leaves its last reservation usable', async () => {
    await putExportReservation('route-a', MAX_REVISION, 'last-content');
    await expect(reserveExportRevision('route-a', 'changed-content')).rejects.toBeInstanceOf(
      RevisionExhaustedError,
    );
    await expect(reserveExportRevision('route-a', 'changed-content')).rejects.toMatchObject({
      code: 'REVISION_EXHAUSTED',
    });
    expect(await reserveExportRevision('route-a', 'last-content')).toBe(MAX_REVISION);
  });

  it('rejects invalid identities without allocating', async () => {
    await expect(reserveExportRevision('', 'hash')).rejects.toThrow('nonempty');
    await expect(reserveExportRevision('route-a', '')).rejects.toThrow('nonempty');
    expect(await reserveExportRevision('route-a', 'hash')).toBe(1);
  });

  it('surfaces storage failures so callers cannot silently reuse an identity', async () => {
    vi.stubGlobal('indexedDB', {
      open() {
        throw new DOMException('Storage unavailable', 'SecurityError');
      },
    });
    await expect(reserveExportRevision('route-a', 'hash')).rejects.toThrow('Storage unavailable');
  });
});

const ROUTE_KEY = '01'.repeat(16);

function currentDraft(): Draft {
  const file = parseRouteFile(
    '<gpx><trk><name>Forest trail</name><trkseg><trkpt lat="0" lon="0"><ele>100</ele></trkpt><trkpt lat="0" lon="0.001"><ele>110</ele></trkpt><trkpt lat="0" lon="0.002"><ele>120</ele></trkpt></trkseg></trk></gpx>',
    'forest.gpx',
  );
  const reference = buildReference(file.routes[0]);
  return {
    version: DRAFT_VERSION,
    editor: {
      file,
      reference,
      stations: createStations(reference, file.landmarks),
      options: { ...PROCESSING_DEFAULTS },
      name: 'Forest trail',
      routeId: new Uint8Array(16).fill(1),
      inputSha256: new Uint8Array(32).fill(2),
      sourceIndex: 0,
      reverse: false,
      startIndex: 0,
    },
    ledger: { [ROUTE_KEY]: { revision: 7 } },
    savedAt: 1234,
  };
}

async function readStoredDraft(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('drafts').objectStore('drafts').get('current');
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
      get.onerror = () => {
        db.close();
        reject(get.error);
      };
    };
  });
}

describe('draft schema', () => {
  it('keeps current settings and optional declination fields unchanged', () => {
    const draft = currentDraft();
    expect(parseDraft(draft)).toEqual(draft);
    expect(parseDraft(draft).editor.magneticDeclination).toBeUndefined();
    expect(parseDraft(draft).editor.declinationMode).toBeUndefined();
    expect(parseDraft(draft).editor.declinationQueryDate).toBeUndefined();
  });

  it('round-trips incomplete and invalid editable values for later processing diagnostics', async () => {
    const draft = currentDraft();
    draft.editor.name = '';
    Object.assign(draft.editor.options, {
      geometryToleranceM: NaN,
      elevationIntervalM: 0,
      smoothingWindowM: -10,
    });
    Object.assign(draft.editor.stations[0], {
      name: '',
      shortLabel: '',
      s: NaN,
      lat: 999,
      lon: NaN,
    });
    draft.editor.magneticDeclination = {
      declinationCdeg: NaN,
      referenceLatE7: NaN,
      referenceLonE7: 2e9,
      referenceDate: '',
      source: '',
      validFrom: '2026-10-17',
    };
    draft.editor.declinationMode = 'manual';
    draft.editor.declinationQueryDate = '';
    await saveDraft(draft);
    expect(await loadDraft()).toEqual(draft);
  });

  it('preserves a source that cleans to one point and zero distance', async () => {
    const draft = currentDraft();
    draft.editor.file.routes[0].points = [
      draft.editor.file.routes[0].points[0],
      draft.editor.file.routes[0].points[0],
    ];
    draft.editor.reference = buildReference(draft.editor.file.routes[0]);
    draft.editor.stations = createStations(draft.editor.reference, []);
    expect(draft.editor.reference.points).toHaveLength(1);
    expect(draft.editor.reference.totalM).toBe(0);
    await saveDraft(draft);
    expect(await loadDraft()).toEqual(draft);
  });

  it('preserves an editable station list exceeding the wire event limit', async () => {
    const draft = currentDraft();
    const station = draft.editor.stations[0];
    draft.editor.stations = Array.from({ length: IMPORT_LIMITS.maxLandmarks + 2 }, (_, index) => ({
      ...station,
      id: index + 1,
    }));
    await saveDraft(draft);
    expect((await loadDraft())?.editor.stations).toHaveLength(IMPORT_LIMITS.maxLandmarks + 2);
  });

  it.each([
    [
      'route identity',
      (draft: Draft) => {
        draft.editor.routeId = Uint8Array.of(1, 2, 3);
      },
      'editor.routeId',
    ],
    [
      'zero identity',
      (draft: Draft) => {
        draft.editor.routeId = new Uint8Array(16);
      },
      'editor.routeId',
    ],
    [
      'input digest',
      (draft: Draft) => {
        draft.editor.inputSha256 = new Uint8Array(31);
      },
      'editor.inputSha256',
    ],
    [
      'segment selection',
      (draft: Draft) => {
        draft.editor.sourceIndex = 10;
      },
      'editor.sourceIndex',
    ],
    [
      'open route start',
      (draft: Draft) => {
        draft.editor.startIndex = 1;
      },
      'editor.startIndex',
    ],
    [
      'source coordinates',
      (draft: Draft) => {
        draft.editor.file.routes[0].points[0].lat = Infinity;
      },
      'editor.file.routes[0].points[0].lat',
    ],
    [
      'source height',
      (draft: Draft) => {
        draft.editor.file.routes[0].points[0].elevation = NaN;
      },
      'editor.file.routes[0].points[0].elevation',
    ],
    [
      'reference order',
      (draft: Draft) => {
        draft.editor.reference.points[1].s = -1;
      },
      'editor.reference.points[1].s',
    ],
    [
      'reference total',
      (draft: Draft) => {
        draft.editor.reference.totalM += 1;
      },
      'editor.reference.totalM',
    ],
    [
      'reference closure',
      (draft: Draft) => {
        draft.editor.reference.isClosed = true;
      },
      'editor.reference.isClosed',
    ],
    [
      'reference count',
      (draft: Draft) => {
        draft.editor.reference.points = [];
      },
      'editor.reference.points',
    ],
    [
      'station count',
      (draft: Draft) => {
        draft.editor.stations = [];
      },
      'editor.stations',
    ],
    [
      'station identity',
      (draft: Draft) => {
        draft.editor.stations[1].id = draft.editor.stations[0].id;
      },
      'editor.stations[1].id',
    ],
    [
      'source budget',
      (draft: Draft) => {
        draft.editor.file.routes[0].points = Array(IMPORT_LIMITS.maxPoints + 1).fill(
          draft.editor.file.routes[0].points[0],
        );
      },
      'editor.file.routes[0].points',
    ],
    [
      'candidate budget',
      (draft: Draft) => {
        draft.editor.stations[0].candidates = Array(PROCESSING_LIMITS.maxMatchCandidates + 1).fill({
          lat: 0,
          lon: 0,
          s: 0,
          distanceM: 0,
        });
      },
      'editor.stations[0].candidates',
    ],
    [
      'export ledger',
      (draft: Draft) => {
        draft.ledger[ROUTE_KEY].revision = MAX_REVISION + 1;
      },
      'ledger.',
    ],
    [
      'save time',
      (draft: Draft) => {
        draft.savedAt = NaN;
      },
      'savedAt',
    ],
  ])('rejects malformed %s with a field path', (_label, mutate, field) => {
    const draft = currentDraft();
    mutate(draft);
    expect(() => parseDraft(draft)).toThrow(field);
  });

  it('rejects invalid primitive and nested field types', () => {
    const malformed = [
      {
        ...currentDraft(),
        editor: { ...currentDraft().editor, options: { geometryToleranceM: '2' } },
      },
      { ...currentDraft(), editor: { ...currentDraft().editor, stations: [null] } },
      {
        ...currentDraft(),
        editor: {
          ...currentDraft().editor,
          file: { ...currentDraft().editor.file, warnings: 'warning' },
        },
      },
      {
        ...currentDraft(),
        editor: {
          ...currentDraft().editor,
          file: { ...currentDraft().editor.file, warnings: ['warning'] },
        },
      },
      { ...currentDraft(), editor: { ...currentDraft().editor, reverse: 'false' } },
      {
        ...currentDraft(),
        editor: {
          ...currentDraft().editor,
          reference: {
            ...currentDraft().editor.reference,
            issues: [{ code: 'UNKNOWN', severity: 'warning', params: { count: {} } }],
          },
        },
      },
      { ...currentDraft(), ledger: null },
    ];
    for (const draft of malformed) expect(() => parseDraft(draft)).toThrow('Invalid saved draft');
  });

  it.each([0, 1, 2, DRAFT_VERSION + 1, '2', undefined])(
    'rejects unsupported version %s',
    (version) => {
      expect(() => parseDraft({ ...currentDraft(), version })).toThrow(
        'Unsupported saved draft version',
      );
    },
  );
});

describe('draft storage', () => {
  it('supports fresh installation without an existing draft', async () => {
    expect(await loadDraft()).toBeNull();
    const draft = currentDraft();
    await saveDraft(draft);
    expect(await loadDraft()).toEqual(draft);
    expect(await reserveExportRevision('route-a', 'hash')).toBe(1);
  });

  it.each([
    ['old version', () => ({ ...currentDraft(), version: 1 }), 'Unsupported saved draft version'],
    [
      'future version',
      () => ({ ...currentDraft(), version: DRAFT_VERSION + 1 }),
      'Unsupported saved draft version',
    ],
    [
      'missing reference',
      () => ({ ...currentDraft(), editor: { ...currentDraft().editor, reference: undefined } }),
      'editor.reference',
    ],
  ])('leaves the stored record intact after rejecting %s', async (_label, record, message) => {
    const db = await openVersionOne();
    const stored = record();
    await putStoredDraft(db, stored);
    db.close();
    await expect(loadDraft()).rejects.toThrow(message);
    expect(await readStoredDraft()).toEqual(stored);
    expect(await reserveExportRevision(ROUTE_KEY, 'next')).toBe(1);
  });

  it('leaves a saved draft intact when a new write is malformed', async () => {
    const draft = currentDraft();
    await saveDraft(draft);
    await expect(saveDraft({ ...draft, editor: null } as unknown as Draft)).rejects.toThrow(
      'editor',
    );
    expect(await loadDraft()).toEqual(draft);
  });

  it('reports a blocked database upgrade instead of leaving the caller pending', async () => {
    const oldDatabase = await openVersionOne();
    try {
      await expect(reserveExportRevision('route-a', 'hash')).rejects.toThrow(
        'blocked by another open tab',
      );
    } finally {
      oldDatabase.close();
    }
    // The blocked open may finish its schema upgrade, but must not allocate a revision.
    expect(await reserveExportRevision('route-a', 'hash')).toBe(1);
  });
});

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

function putLegacyDraft(db: IDBDatabase, draft: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite');
    transaction.objectStore('drafts').put(draft, 'current');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
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

  it('advances beyond the legacy ledger when first migrating a route', async () => {
    expect(await reserveExportRevision('route-a', 'canonical-hash', 7)).toBe(8);
    expect(await reserveExportRevision('route-a', 'canonical-hash', 8)).toBe(8);
    expect(await reserveExportRevision('route-a', 'new-content', 8)).toBe(9);
  });

  it('honors a newer legacy ledger from another migrating tab', async () => {
    expect(await reserveExportRevision('route-a', 'tab-one', 2)).toBe(3);
    expect(await reserveExportRevision('route-a', 'tab-two', 5)).toBe(6);
  });

  it('does not wrap an exhausted revision and leaves its last reservation usable', async () => {
    expect(await reserveExportRevision('route-a', 'last-content', MAX_REVISION - 1)).toBe(
      MAX_REVISION,
    );
    await expect(reserveExportRevision('route-a', 'changed-content')).rejects.toBeInstanceOf(
      RevisionExhaustedError,
    );
    await expect(reserveExportRevision('route-a', 'changed-content')).rejects.toMatchObject({
      code: 'REVISION_EXHAUSTED',
    });
    expect(await reserveExportRevision('route-a', 'last-content')).toBe(MAX_REVISION);
    await expect(
      reserveExportRevision('legacy-exhausted', 'first-migration', MAX_REVISION),
    ).rejects.toBeInstanceOf(RevisionExhaustedError);
  });

  it('rejects invalid identities and legacy revisions without allocating', async () => {
    await expect(reserveExportRevision('', 'hash')).rejects.toThrow('nonempty');
    await expect(reserveExportRevision('route-a', '')).rejects.toThrow('nonempty');
    for (const revision of [-1, 0.5, MAX_REVISION + 1, NaN]) {
      await expect(reserveExportRevision('route-a', 'hash', revision)).rejects.toThrow('range');
    }
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

function legacyDraft(version: 1 | 2) {
  const draft = currentDraft();
  return {
    ...draft,
    version,
    editor: {
      ...draft.editor,
      options: { ...draft.editor.options, elevationMode: 'omit' },
      magneticDeclination: {
        declinationCdeg: 0,
        referenceLatE7: 0,
        referenceLonE7: 0,
        referenceDate: '2026-10-17',
        source: 'manual',
        referenceHeightDm: 123,
      },
    },
    ledger: { ...draft.ledger, earlierRoute: { revision: 19, hash: 'old-hash' } },
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

describe('draft schema and migration', () => {
  it.each([1, 2] as const)(
    'migrates version %i without mutating edits, identity or revision history',
    (version) => {
      const legacy = legacyDraft(version);
      const migrated = parseDraft(legacy);
      expect(migrated.version).toBe(DRAFT_VERSION);
      expect(migrated.editor.options).toEqual({
        ...legacy.editor.options,
        elevationMode: 'source',
      });
      expect(migrated.editor.magneticDeclination).toEqual({
        declinationCdeg: 0,
        referenceLatE7: 0,
        referenceLonE7: 0,
        referenceDate: '2026-10-17',
        source: 'manual',
      });
      expect(migrated.editor.routeId).toEqual(legacy.editor.routeId);
      expect(migrated.editor.stations).toEqual(legacy.editor.stations);
      expect(migrated.ledger).toEqual(legacy.ledger);
      expect(legacy.editor.options.elevationMode).toBe('omit');
      expect(legacy.editor.magneticDeclination.referenceHeightDm).toBe(123);
    },
  );

  it('keeps current settings and optional declination fields unchanged', () => {
    const draft = currentDraft();
    expect(parseDraft(draft)).toEqual(draft);
    expect(parseDraft(draft).editor.magneticDeclination).toBeUndefined();
    expect(parseDraft(draft).editor.declinationMode).toBeUndefined();
    expect(parseDraft(draft).editor.declinationQueryDate).toBeUndefined();
  });

  it.each([1, 2] as const)(
    'restores string warnings from version %i without losing the editor or history',
    (version) => {
      const draft = legacyDraft(version);
      const legacy = {
        ...draft,
        editor: {
          ...draft.editor,
          file: {
            ...draft.editor.file,
            warnings: [
              'Check the source heights.',
              { code: 'IMPORT_MULTIPLE_SEGMENTS', params: { count: 2 } },
            ],
          },
        },
      };
      const migrated = parseDraft(legacy);
      expect(migrated.editor.file.warnings).toEqual([
        { code: 'import', message: 'Check the source heights.' },
        { code: 'IMPORT_MULTIPLE_SEGMENTS', params: { count: 2 } },
      ]);
      expect(migrated.editor.name).toBe(legacy.editor.name);
      expect(migrated.editor.routeId).toEqual(legacy.editor.routeId);
      expect(migrated.ledger).toEqual(legacy.ledger);
      expect(legacy.editor.file.warnings[0]).toBe('Check the source heights.');
    },
  );

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

  it('does not apply legacy settings migration to the current version', () => {
    expect(() => parseDraft({ ...legacyDraft(2), version: DRAFT_VERSION })).toThrow(
      'editor.options.elevationMode',
    );
  });

  it.each([0, DRAFT_VERSION + 1, '2', undefined])('rejects unsupported version %s', (version) => {
    expect(() => parseDraft({ ...currentDraft(), version })).toThrow(
      'Unsupported saved draft version',
    );
  });
});

describe('draft storage migration', () => {
  it('preserves old draft data and revision history through the database upgrade', async () => {
    const oldDatabase = await openVersionOne();
    const legacy = legacyDraft(1);
    await putLegacyDraft(oldDatabase, legacy);
    oldDatabase.close();
    expect(await reserveExportRevision(ROUTE_KEY, 'new-hash', 7)).toBe(8);
    const migrated = await loadDraft();
    expect(migrated).toEqual(parseDraft(legacy));
    expect(await readStoredDraft()).toEqual(legacy);
    const updated = { ...migrated!, savedAt: 4321 };
    await saveDraft(updated);
    expect(await loadDraft()).toEqual(updated);
    expect(await reserveExportRevision(ROUTE_KEY, 'new-hash')).toBe(8);
  });

  it('supports fresh installation without an existing draft', async () => {
    expect(await loadDraft()).toBeNull();
    const draft = currentDraft();
    await saveDraft(draft);
    expect(await loadDraft()).toEqual(draft);
    expect(await reserveExportRevision('route-a', 'hash')).toBe(1);
  });

  it.each([
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
    await putLegacyDraft(db, stored);
    db.close();
    await expect(loadDraft()).rejects.toThrow(message);
    expect(await readStoredDraft()).toEqual(stored);
    expect(await reserveExportRevision(ROUTE_KEY, 'next', 7)).toBe(8);
  });

  it('leaves a saved draft intact when a new write is malformed', async () => {
    const draft = currentDraft();
    await saveDraft(draft);
    await expect(saveDraft({ ...draft, editor: null } as unknown as Draft)).rejects.toThrow(
      'editor',
    );
    expect(await loadDraft()).toEqual(draft);
  });

  it('reports a blocked migration instead of leaving the caller pending', async () => {
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

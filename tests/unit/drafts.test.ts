import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDraft, migrateDraftEditor, reserveExportRevision, RevisionExhaustedError, saveDraft } from '../../src/app/drafts';

const DB_NAME = 'trl-x-route-studio';
const MAX_REVISION = 0xffffffff;

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.unstubAllGlobals(); });

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
    expect(await Promise.all(Array.from({ length: 8 }, () => reserveExportRevision('route-a', 'same-content')))).toEqual(Array(8).fill(1));
    expect(await reserveExportRevision('route-a', 'same-content')).toBe(1);
  });

  it('allocates monotonically across multiple independent database connections', async () => {
    const revisions = await Promise.all(Array.from({ length: 20 }, (_, index) => reserveExportRevision('route-a', `content-${index}`)));
    expect([...revisions].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
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
    expect(await reserveExportRevision('route-a', 'last-content', MAX_REVISION - 1)).toBe(MAX_REVISION);
    await expect(reserveExportRevision('route-a', 'changed-content')).rejects.toBeInstanceOf(RevisionExhaustedError);
    await expect(reserveExportRevision('route-a', 'changed-content')).rejects.toMatchObject({ code: 'REVISION_EXHAUSTED' });
    expect(await reserveExportRevision('route-a', 'last-content')).toBe(MAX_REVISION);
    await expect(reserveExportRevision('legacy-exhausted', 'first-migration', MAX_REVISION)).rejects.toBeInstanceOf(RevisionExhaustedError);
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
    vi.stubGlobal('indexedDB', { open() { throw new DOMException('Storage unavailable', 'SecurityError'); } });
    await expect(reserveExportRevision('route-a', 'hash')).rejects.toThrow('Storage unavailable');
  });
});

describe('draft storage migration', () => {
  it('upgrades elevation omission and removes obsolete declination height without changing identity or edits', () => {
    const legacy = {
      routeId: Uint8Array.of(1, 2, 3), name: '旧草稿', stations: [{ name: 'CP1', s: 125 }],
      options: { geometryToleranceM: 4, elevationIntervalM: 20, smoothingWindowM: 0, elevationMode: 'omit' as const, acceptUncertainElevation: false },
      magneticDeclination: { declinationCdeg: 0, referenceLatE7: 0, referenceLonE7: 0, referenceDate: '2026-10-17', source: 'manual', referenceHeightDm: 123 },
    };
    const migrated = migrateDraftEditor(legacy);
    expect(migrated.options).toEqual({ ...legacy.options, elevationMode: 'source' });
    expect(migrated.magneticDeclination).toEqual({ declinationCdeg: 0, referenceLatE7: 0, referenceLonE7: 0, referenceDate: '2026-10-17', source: 'manual' });
    expect(migrated.routeId).toEqual(legacy.routeId);
    expect(migrated.name).toBe(legacy.name);
    expect(migrated.stations).toEqual(legacy.stations);
    expect(legacy.options.elevationMode).toBe('omit');
    expect(legacy.magneticDeclination.referenceHeightDm).toBe(123);
  });

  it('preserves current elevation settings without inventing optional magnetic metadata', () => {
    for (const elevationMode of ['source', 'interpolate'] as const) {
      const current = { options: { geometryToleranceM: 2, elevationIntervalM: 10, smoothingWindowM: 0, elevationMode, acceptUncertainElevation: true } };
      expect(migrateDraftEditor(current)).toEqual(current);
      expect(migrateDraftEditor(current).magneticDeclination).toBeUndefined();
    }
  });

  it('preserves the old draft store and its typed-array data through the version-two upgrade', async () => {
    const oldDatabase = await openVersionOne();
    const legacyDraft = { version: 1, editor: { routeId: Uint8Array.of(1, 2, 3), name: '旧草稿' }, ledger: { previous: { revision: 7, hash: 'old-hash' } } };
    await putLegacyDraft(oldDatabase, legacyDraft);
    oldDatabase.close();
    expect(await reserveExportRevision('previous', 'new-hash', 7)).toBe(8);
    expect(await loadDraft()).toEqual(legacyDraft);
    const updated = { ...legacyDraft, savedAt: 1234 };
    await saveDraft(updated);
    expect(await loadDraft()).toEqual(updated);
    expect(await reserveExportRevision('previous', 'new-hash')).toBe(8);
  });

  it('supports fresh installation without an existing draft', async () => {
    expect(await loadDraft()).toBeNull();
    await saveDraft({ name: 'fresh' });
    expect(await loadDraft()).toEqual({ name: 'fresh' });
    expect(await reserveExportRevision('route-a', 'hash')).toBe(1);
  });

  it('reports a blocked migration instead of leaving the caller pending', async () => {
    const oldDatabase = await openVersionOne();
    try {
      await expect(reserveExportRevision('route-a', 'hash')).rejects.toThrow('blocked by another open tab');
    } finally { oldDatabase.close(); }
    // The previously blocked open may finish the harmless schema migration;
    // it must close its connection and must not allocate a reservation.
    expect(await reserveExportRevision('route-a', 'hash')).toBe(1);
  });
});

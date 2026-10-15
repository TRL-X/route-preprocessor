const DB_NAME = 'trl-x-route-studio';
const DB_VERSION = 2;
const MAX_REVISION = 0xffffffff;

interface ExportReservation { revision: number; contentHash: string }

/** Exhaustion is permanent for this identity, rather than a storage failure. */
export class RevisionExhaustedError extends Error {
  readonly code = 'REVISION_EXHAUSTED';
  constructor() {
    super('This route has exhausted its revisions. Re-import it as a new route.');
    this.name = 'RevisionExhaustedError';
  }
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts');
      if (!db.objectStoreNames.contains('exports')) db.createObjectStore('exports');
    };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      // Cooperate with a future schema upgrade in another open tab.
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Local storage upgrade is blocked by another open tab. Close older tabs and retry.'));
    };
  });
}

/**
 * Reserves an immutable revision before bytes are downloaded. IndexedDB serializes
 * readwrite transactions across tabs, so no two different contents can claim the
 * same route ID/revision. A failed later encode/download may leave a harmless gap.
 * contentHash must hash the canonical bytes with a fixed revision (e.g. revision 1).
 */
export async function reserveExportRevision(routeId: string, contentHash: string, legacyRevision = 0): Promise<number> {
  if (!routeId || !contentHash || typeof routeId !== 'string' || typeof contentHash !== 'string') {
    throw new Error('Export route identity and content hash must be nonempty strings.');
  }
  if (!Number.isInteger(legacyRevision) || legacyRevision < 0 || legacyRevision > MAX_REVISION) {
    throw new Error('The previous export revision is outside the supported range.');
  }
  const db = await database();
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction('exports', 'readwrite');
      const store = tx.objectStore('exports');
      const request = store.get(routeId);
      let revision: number | undefined;
      let failure: Error | undefined;
      tx.oncomplete = () => revision === undefined ? reject(new Error('Export revision reservation did not complete.')) : resolve(revision);
      tx.onerror = () => reject(failure ?? tx.error ?? new Error('Export revision reservation failed.'));
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Export revision reservation was aborted.'));
      request.onsuccess = () => {
        try {
          const existing = request.result as ExportReservation | undefined;
          if (existing !== undefined && (!existing || !Number.isInteger(existing.revision) || existing.revision < 1 ||
            existing.revision > MAX_REVISION || typeof existing.contentHash !== 'string' || !existing.contentHash)) {
            throw new Error('The saved export history is invalid.');
          }
          if (existing?.contentHash === contentHash) { revision = existing.revision; return; }
          // Account for legacy history if a second upgrading tab has a newer
          // pre-migration ledger than the one that created this reservation store.
          const previous = Math.max(existing?.revision ?? 0, legacyRevision);
          if (previous === MAX_REVISION) throw new RevisionExhaustedError();
          revision = previous + 1;
          store.put({ revision, contentHash } satisfies ExportReservation, routeId);
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          tx.abort();
        }
      };
    });
  } finally { db.close(); }
}

export async function saveDraft(value: unknown): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put(value, 'current');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function loadDraft<T>(): Promise<T | null> {
  const db = await database();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get('current');
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

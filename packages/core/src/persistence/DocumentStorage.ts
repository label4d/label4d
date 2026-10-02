import type { SnapshotDocument, SnapshotQA } from '../io/snapshot';
import type { StorePatch } from '../model/TrackStore';

export interface DurableEdit {
  operationId: string;
  beforeRevision: number;
  revision: number;
  action: 'apply' | 'undo' | 'redo';
  patch: StorePatch;
  inverse: StorePatch;
  review: SnapshotQA;
  inverseReview: SnapshotQA;
}
export interface StoredDocument {
  schema: 'labelfaster.local.v1';
  revision: number;
  baseline: SnapshotDocument;
  edits: DurableEdit[];
}
export interface DocumentStorage {
  open(key: string, initial: SnapshotDocument): Promise<StoredDocument>;
  append(edit: DurableEdit): Promise<void>;
  close(): void;
}

/** Single writer via an IndexedDB lease and fencing token, checked in every write transaction. */
export class IndexedDbDocumentStorage implements DocumentStorage {
  private db: IDBDatabase | null = null;
  private key = '';
  private token = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly owner = crypto.randomUUID();
  private releaseLock: (() => void) | null = null;
  private browserLock = false;
  constructor(private readonly databaseName = 'labelfaster-documents') {}

  async open(key: string, initial: SnapshotDocument): Promise<StoredDocument> {
    if (this.closed) throw new Error('Storage is closed');
    this.key = key;
    // Browser locks are released by the browser even if a tab crashes or reloads.
    // The lease/fencing token remains the fallback and guards every IDB append.
    if (typeof navigator !== 'undefined' && navigator.locks) {
      const acquired = await new Promise<boolean>((resolve, reject) => {
        void navigator.locks.request(`${this.databaseName}:${key}`, { ifAvailable: true }, async (lock) => {
          if (!lock) { resolve(false); return; }
          this.browserLock = true;
          const held = new Promise<void>((release) => { this.releaseLock = release; });
          resolve(true);
          await held;
        }).catch(reject);
      });
      if (this.closed) { this.releaseLock?.(); throw new Error('Storage is closed'); }
      if (!acquired) throw new Error('This document is being edited in another tab');
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 2);
      request.onupgradeneeded = () => {
        const upgrade = request.transaction!;
        const heads = request.result.objectStoreNames.contains('documents')
          ? upgrade.objectStore('documents') : request.result.createObjectStore('documents');
        const logs = request.result.createObjectStore('edits', { keyPath: ['key', 'revision'] });
        logs.createIndex('operation', ['key', 'operationId'], { unique: true });
        // Upgrade the former envelope atomically; never discard an existing history.
        const cursor = heads.openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const record = entry.value as StoredRecord;
          for (const edit of record.document.edits) logs.add({ key: entry.key, ...edit });
          entry.update({ ...record, document: { ...record.document, edits: [] } });
          entry.continue();
        };
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    if (this.closed) { db.close(); throw new Error('Storage is closed'); }
    this.db = db;
    const document = await this.write((record) => {
      const lease = record?.lease;
      if (!this.browserLock && lease && lease.owner !== this.owner && lease.expires > Date.now()) throw new Error('This document is being edited in another tab');
      this.token = crypto.randomUUID();
      const value = record?.document ?? { schema: 'labelfaster.local.v1' as const, revision: 0, baseline: initial, edits: [] };
      return { document: value, lease: { owner: this.owner, token: this.token, expires: Date.now() + 20_000 } };
    });
    if (this.closed) throw new Error('Storage is closed');
    this.timer = setInterval(() => {
      void this.write((record) => { this.assertOwnership(record); return { ...record!, lease: { ...record!.lease, expires: Date.now() + 20_000 } }; }).catch(() => {});
    }, 5_000);
    // Read a consistent journal range after acquiring the writer lease.
    const edits = await new Promise<DurableEdit[]>((resolve, reject) => {
      const tx = db.transaction('edits', 'readonly');
      const request = tx.objectStore('edits').getAll(IDBKeyRange.bound([key, 0], [key, document.revision]));
      tx.oncomplete = () => resolve(request.result.map(({ key: _key, ...edit }) => edit));
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Journal read failed'));
    });
    if (this.closed) throw new Error('Storage is closed');
    return { ...document, edits };
  }

  async append(edit: DurableEdit): Promise<void> {
    const db = this.db;
    if (!db || this.closed) throw new Error('Storage is closed');
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['documents', 'edits'], 'readwrite');
      const heads = tx.objectStore('documents');
      const logs = tx.objectStore('edits');
      const request = heads.get(this.key);
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const record = request.result as StoredRecord | undefined;
          this.assertOwnership(record);
          if (record!.document.revision !== edit.beforeRevision || edit.revision !== edit.beforeRevision + 1) {
            throw new Error('Document revision conflict');
          }
          // The unique operation index also prevents retries from appending twice.
          logs.add({ key: this.key, ...edit });
          heads.put({ document: { ...record!.document, revision: edit.revision },
            lease: { ...record!.lease, expires: Date.now() + 20_000 } }, this.key);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('Storage transaction aborted'));
    });
  }

  close(): void {
    this.closed = true;
    this.releaseLock?.(); this.releaseLock = null;
    if (this.timer) clearInterval(this.timer);
    const db = this.db;
    if (!db) return;
    // Release only our own fenced lease; never overwrite another writer's document.
    const tx = db.transaction('documents', 'readwrite'); const store = tx.objectStore('documents');
    const request = store.get(this.key);
    request.onsuccess = () => {
      const record = request.result as StoredRecord | undefined;
      if (record?.lease.owner === this.owner && record.lease.token === this.token) {
        store.put({ ...record, lease: { ...record.lease, expires: 0 } }, this.key);
      }
    };
    tx.oncomplete = tx.onabort = () => db.close();
    this.db = null;
  }

  private assertOwnership(record?: StoredRecord): void {
    if (this.closed || !record || record.lease.owner !== this.owner || record.lease.token !== this.token || record.lease.expires <= Date.now()) {
      throw new Error('Document write lease expired or was replaced');
    }
  }

  private write(update: (record?: StoredRecord) => StoredRecord): Promise<StoredDocument> {
    const db = this.db;
    if (!db || this.closed) return Promise.reject(new Error('Storage is closed'));
    return new Promise((resolve, reject) => {
      const tx = db.transaction('documents', 'readwrite'); const store = tx.objectStore('documents');
      const request = store.get(this.key); let value: StoredRecord; let failure: unknown;
      request.onsuccess = () => {
        try { value = update(request.result); store.put(value, this.key); }
        catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(structuredClone(value.document));
      tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('Storage transaction aborted'));
    });
  }
}
interface StoredRecord {
  document: StoredDocument;
  lease: { owner: string; token: string; expires: number };
}

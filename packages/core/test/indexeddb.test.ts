import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IndexedDbDocumentStorage } from '../src/persistence/DocumentStorage';
import type { DurableEdit, StoredDocument } from '../src/persistence/DocumentStorage';
import type { SnapshotDocument } from '../src/io/snapshot';

const baseline: SnapshotDocument = { formatVersion: 1, sequenceId: 'test', frameCount: 11, createdAt: '', tracks: [], geometries: [] };
const edit = (revision: number, operationId = `op-${revision}`): DurableEdit => ({ operationId, beforeRevision: revision - 1, revision,
  action: 'apply', patch: { tracks: [], geometries: [] }, inverse: { tracks: [], geometries: [] },
  review: { status: 'pending' }, inverseReview: { status: 'pending' } });
const open = (name: string, version?: number) => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = () => request.result.createObjectStore('documents');
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const complete = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
});

describe('IndexedDB journal and fencing', () => {
  beforeAll(() => vi.stubGlobal('navigator', undefined)); // Exercise lease fallback; browser tests cover Web Locks.
  afterAll(() => vi.unstubAllGlobals());
  it('appends separate log records and recovers without rewriting the baseline history', async () => {
    const name = crypto.randomUUID(); const storage = new IndexedDbDocumentStorage(name);
    await storage.open('test', baseline); await storage.append(edit(1)); await storage.append(edit(2));
    const db = await open(name); const tx = db.transaction(['documents', 'edits'], 'readonly');
    const head = tx.objectStore('documents').get('test'); const logs = tx.objectStore('edits').getAll();
    await complete(tx); expect(head.result.document.edits).toEqual([]); expect(logs.result).toHaveLength(2); db.close();
    storage.close();
    const reopened = new IndexedDbDocumentStorage(name); const recovered = await reopened.open('test', baseline);
    expect(recovered.revision).toBe(2); expect(recovered.edits.map((e) => e.operationId)).toEqual(['op-1', 'op-2']); reopened.close();
  });
  it('migrates the old envelope atomically and preserves baseline, revision and undo records', async () => {
    const name = crypto.randomUUID(); const db = await open(name, 1);
    const document: StoredDocument = { schema: 'label4d.local.v1', revision: 2, baseline, edits: [edit(1), { ...edit(2), action: 'undo' }] };
    const tx = db.transaction('documents', 'readwrite');
    tx.objectStore('documents').put({ document, lease: { owner: 'old', token: 'old', expires: 0 } }, 'test');
    await complete(tx); db.close();
    const storage = new IndexedDbDocumentStorage(name); const recovered = await storage.open('test', baseline);
    expect(recovered).toEqual(document); await storage.append(edit(3)); storage.close();
  });
  it('rejects duplicate operation IDs and stale revisions without advancing the head', async () => {
    const name = crypto.randomUUID(); const storage = new IndexedDbDocumentStorage(name);
    await storage.open('test', baseline); await storage.append(edit(1));
    await expect(storage.append(edit(2, 'op-1'))).rejects.toBeDefined();
    await expect(storage.append(edit(3))).rejects.toThrow('revision conflict');
    await storage.append(edit(2)); storage.close();
    const reopened = new IndexedDbDocumentStorage(name);
    expect((await reopened.open('test', baseline)).revision).toBe(2); reopened.close();
  });
  it('fences a replaced writer and does not release the replacement lease', async () => {
    const name = crypto.randomUUID(); const first = new IndexedDbDocumentStorage(name); await first.open('test', baseline);
    const second = new IndexedDbDocumentStorage(name); await expect(second.open('test', baseline)).rejects.toThrow('another tab'); second.close();
    const db = await open(name); const tx = db.transaction('documents', 'readwrite'); const heads = tx.objectStore('documents');
    const request = heads.get('test'); request.onsuccess = () => heads.put({ ...request.result, lease: { owner: 'replacement', token: 'replacement', expires: Date.now() + 60_000 } }, 'test');
    await complete(tx); await expect(first.append(edit(1))).rejects.toThrow('lease'); first.close();
    const check = db.transaction('documents', 'readonly'); const current = check.objectStore('documents').get('test'); await complete(check);
    expect(current.result.lease.owner).toBe('replacement'); expect(current.result.document.revision).toBe(0); db.close();
  });
});

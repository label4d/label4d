import { describe, expect, it } from 'vitest';
import { EditorSession } from '../src/session/EditorSession';
import { AddTrackCommand } from '../src/command/commands';
import type { DocumentStorage, DurableEdit, StoredDocument } from '../src/persistence/DocumentStorage';
import type { SnapshotDocument } from '../src/io/snapshot';
import type { SerializedTrack } from '../src/model/types';

const seed: SerializedTrack = {
  meta: { id: 'a', label: 'Car', startFrame: 0, endFrame: 10, interpolation: 'linear', source: 'human', attributes: {} },
  keyframes: { frames: [0, 10], pos: [0, 1, 0, 10, 1, 0], yaw: [0, 0], size: [4, 1.5, 2, 4, 1.5, 2] },
};
const session = async () => {
  const s = new EditorSession({ raf: () => 0, cancelRaf() {} });
  await s.loadManifest({ formatVersion: 1, id: 'test', fps: 10, frameCount: 11 });
  return s;
};

class MemoryStorage implements DocumentStorage {
  document: StoredDocument | null = null;
  fail = false;
  wait: Promise<void> = Promise.resolve();
  async open(_key: string, initial: SnapshotDocument): Promise<StoredDocument> {
    this.document ??= { schema: 'labelfaster.local.v1', revision: 0, baseline: structuredClone(initial), edits: [] };
    return structuredClone(this.document);
  }
  async append(edit: DurableEdit): Promise<void> {
    await this.wait;
    if (this.fail) throw new Error('storage fault');
    if (this.document!.revision !== edit.beforeRevision) throw new Error('revision conflict');
    this.document!.edits.push(structuredClone(edit)); this.document!.revision = edit.revision;
  }
  close() {}
}

describe('Durable edit protocol', () => {
  it('publishes only after storage completes, and blocks overlapping commits', async () => {
    const s = await session(); const storage = new MemoryStorage();
    await s.enablePersistence(storage);
    let complete!: () => void; storage.wait = new Promise<void>((r) => { complete = r; });
    s.history.push(new AddTrackCommand(s.store, seed));
    expect(s.store.trackCount).toBe(0); expect(s.saveStatus).toBe('saving'); expect(s.savedRevision).toBe(0);
    expect(() => s.history.push(new AddTrackCommand(s.store, { ...seed, meta: { ...seed.meta, id: 'b' } }))).toThrow('still being saved');
    complete(); await s.history.whenIdle();
    expect(s.store.trackCount).toBe(1); expect(s.savedRevision).toBe(1); expect(s.saveStatus).toBe('saved'); s.dispose();
  });
  it('leaves the document and history unchanged after storage failure and can retry', async () => {
    const s = await session(); const storage = new MemoryStorage(); await s.enablePersistence(storage);
    storage.fail = true; s.history.push(new AddTrackCommand(s.store, seed));
    await expect(s.history.whenIdle()).rejects.toThrow('storage fault');
    expect(s.store.trackCount).toBe(0); expect(s.history.canUndo).toBe(false);
    expect(s.saveStatus).toBe('error'); expect(s.documentRevision).toBe(0);
    storage.fail = false; s.history.retryFailed(); await s.history.whenIdle();
    expect(s.store.trackCount).toBe(1); expect(s.savedRevision).toBe(1); s.dispose();
  });
  it('persists undo and reconstructs redo on reopening without resurrecting deleted content', async () => {
    const s = await session(); const storage = new MemoryStorage(); await s.enablePersistence(storage);
    s.history.push(new AddTrackCommand(s.store, seed)); await s.history.whenIdle();
    s.undo(); await s.history.whenIdle(); expect(s.store.trackCount).toBe(0); expect(s.savedRevision).toBe(2);
    s.dispose(); const reopened = await session(); await reopened.enablePersistence(storage);
    expect(reopened.store.trackCount).toBe(0); expect(reopened.history.canRedo).toBe(true);
    reopened.redo(); await reopened.history.whenIdle(); expect(reopened.store.serializeTrack('a')).toEqual(seed);
    expect(reopened.savedRevision).toBe(3); reopened.dispose();
  });
  it('persists review and marks it pending after geometry changes, restoring it on exact undo', async () => {
    const s = await session(); s.store.restoreTrack(seed);
    const storage = new MemoryStorage(); await s.enablePersistence(storage);
    s.setQA('pass'); await s.history.whenIdle(); expect(s.qa.status).toBe('pass');
    s.selection.select(['a']); s.nudgeSelection({ x: 2, y: 0, z: 0 }); await s.history.whenIdle();
    expect(s.qa.status).toBe('pending'); s.undo(); await s.history.whenIdle(); expect(s.qa.status).toBe('pass');
    s.dispose(); const reopened = await session(); await reopened.enablePersistence(storage);
    expect(reopened.qa.status).toBe('pass'); reopened.dispose();
  });
  it('refuses a corrupt log without replacing the current document', async () => {
    const s = await session(); const storage = new MemoryStorage(); await s.enablePersistence(storage);
    s.history.push(new AddTrackCommand(s.store, seed)); await s.history.whenIdle(); s.dispose();
    storage.document!.edits[0].revision = 7;
    const reopened = await session(); reopened.store.restoreTrack({ ...seed, meta: { ...seed.meta, id: 'old' } });
    await expect(reopened.enablePersistence(storage)).rejects.toThrow('corrupt');
    expect(reopened.store.getTrack('old')).toBeDefined(); expect(reopened.canEdit).toBe(false); reopened.dispose();
  });
});

describe('Post-commit observers', () => {
  it('keeps a durable edit and its undo stack consistent when a view observer throws', async () => {
    const { vi } = await import('vitest'); const logging = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await session(); const storage = new MemoryStorage(); await s.enablePersistence(storage);
    let notified = 0;
    s.events.on('storeChanged', () => { throw new Error('broken view'); });
    s.events.on('storeChanged', () => notified++);
    try {
      s.history.push(new AddTrackCommand(s.store, seed)); await s.history.whenIdle();
      expect(s.savedRevision).toBe(1); expect(s.saveStatus).toBe('saved'); expect(s.history.canUndo).toBe(true);
      expect(notified).toBe(1); expect(logging).toHaveBeenCalled();
      s.undo(); await s.history.whenIdle(); expect(s.store.trackCount).toBe(0); expect(s.savedRevision).toBe(2);
    } finally { s.dispose(); logging.mockRestore(); }
  });
});

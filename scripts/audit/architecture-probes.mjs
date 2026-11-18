/** Read-only architecture probes. Run after: pnpm --filter @label4d/core build.
 * Prints observations, not acceptance-test PASS claims; makes no production edits.
 */
import {
  EditorSession, TrackStore, History, AddTrackCommand, SetKeyframeCommand,
  SplitTrackCommand, TileScheduler, FrameBuffer, Transaction, applySnapshot,
} from '../../packages/core/dist/index.js';

const seed = (id = 'a') => ({
  meta: { id, label: 'Car', startFrame: 0, endFrame: 10, interpolation: 'linear', source: 'human', attributes: {} },
  keyframes: { frames: [0, 10], pos: [0, 1, 0, 10, 1, 0], yaw: [0, 0], size: [4, 1.5, 2, 4, 1.5, 2] },
});
const print = (probe, observation) => console.log(JSON.stringify({ probe, ...observation }));
const newSession = () => new EditorSession({ raf: () => 0, cancelRaf: () => {} });

const session = newSession();
try {
  session.history.pushTransaction([
    new AddTrackCommand(session.store, seed()), new AddTrackCommand(session.store, seed('b')),
  ]);
  print('batch-recorder', { tracks: session.store.trackCount, canUndo: session.history.canUndo, oplogRecords: session.oplog.all().length });
} catch (error) {
  print('batch-recorder', { error: String(error), tracks: session.store.trackCount,
    canUndo: session.history.canUndo, oplogRecords: session.oplog.all().length });
}
session.dispose();

const splitStore = new TrackStore();
splitStore.restoreTrack(seed());
const beforeSplit = [4, 5, 6].map((f) => splitStore.resolveState('a', f)?.pos.x);
new SplitTrackCommand(splitStore, 'a', 5, 'b').apply();
print('split-interpolation', { before: beforeSplit, after: [
  splitStore.resolveState('a', 4)?.pos.x, splitStore.resolveState('b', 5)?.pos.x,
  splitStore.resolveState('b', 6)?.pos.x,
] });

const undoStore = new TrackStore();
undoStore.restoreTrack(seed());
const history = new History();
history.push(new SetKeyframeCommand(undoStore, 'a', 20,
  { pos: { x: 20, y: 1, z: 0 }, yaw: 0, size: { x: 4, y: 1.5, z: 2 } }));
history.undo();
print('undo-interval', { expectedEnd: 10, actualEnd: undoStore.getTrack('a').meta.endFrame,
  stateAt15: undoStore.resolveState('a', 15) });

const atomicStore = new TrackStore();
const transaction = new Transaction([
  new AddTrackCommand(atomicStore, seed()),
  { name: 'fault', payload: {}, apply() { throw new Error('injected failure'); }, undo() {} },
]);
try { transaction.apply(); } catch { /* Observe whether the first child remains. */ }
print('transaction-atomicity', { expectedTracks: 0, actualTracks: atomicStore.trackCount });

let finish;
const scheduler = new TileScheduler({ budgetBytes: 100 });
const pending = scheduler.request('x', 0, 10, () => new Promise((resolve) => { finish = resolve; }));
const cancelled = pending.catch((error) => error.name);
await new Promise((resolve) => setTimeout(resolve, 0));
scheduler.cancel('x');
finish('old');
const cancelledValue = await cancelled;
await new Promise((resolve) => setTimeout(resolve, 0));
print('cancel-running', { resolvedValue: cancelledValue, stats: scheduler.stats() });

let complete;
const clearScheduler = new TileScheduler();
const buffer = new FrameBuffer({
  load: () => new Promise((resolve) => { complete = resolve; }), bytes: () => 20, dispose() {},
}, clearScheduler, { windowAhead: 0, windowBehind: 0 });
const inflight = buffer.ensure(0);
const rejected = inflight.catch((error) => error.name);
await new Promise((resolve) => setTimeout(resolve, 0));
buffer.clear();
complete('late');
await rejected;
print('clear-late-response', { stats: buffer.stats(), value: buffer.get(0) });
buffer.dispose(); scheduler.dispose(); clearScheduler.dispose();

const importStore = new TrackStore();
importStore.restoreTrack(seed('old'));
try {
  applySnapshot(importStore, { formatVersion: 1, sequenceId: 's', frameCount: 11,
    tracks: [seed('new'), { meta: { id: 'bad' } }], geometries: [] });
} catch (error) {
  print('snapshot-partial-import', { error: String(error), ids: importStore.listTracks().map((t) => t.meta.id) });
}

const editing = newSession();
await editing.loadManifest({ formatVersion: 1, id: 'editing', fps: 10, frameCount: 11 });
editing.store.restoreTrack(seed());
editing.selection.select(['a']);
editing.setFrame(5);
await new Promise((resolve) => setTimeout(resolve, 0));
editing.applyIntent({ type: 'moveSelection', delta: { x: 1, y: 0, z: 0 } });
print('move-scope', { editedFrame: 5, first: editing.store.resolveState('a', 0).pos.x,
  last: editing.store.resolveState('a', 10).pos.x, keyframes: [...editing.store.getKeyframes('a').frames] });
editing.undo();
print('undo-log', { records: editing.oplog.all().map((r) => r.name), currentFirst: editing.store.resolveState('a', 0).pos.x });
editing.dispose();

const replacement = newSession();
replacement.store.restoreTrack(seed('old-sequence-track'));
await replacement.loadManifest({ formatVersion: 1, id: 'new-sequence', fps: 10, frameCount: 11 });
print('manifest-document-isolation', { sequence: replacement.manifest.id,
  trackIds: replacement.store.listTracks().map((t) => t.meta.id) });
replacement.dispose();

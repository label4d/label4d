import { describe, expect, it } from 'vitest';
import { EditorSession } from '../src/session/EditorSession';
import { TrackStore } from '../src/model/TrackStore';
import { AddTrackCommand, SetKeyframeCommand, SplitTrackCommand, MergeTracksCommand, createCommand } from '../src/command/commands';
import { applySnapshot } from '../src/io/snapshot';
import type { SnapshotDocument } from '../src/io/snapshot';
import { TileScheduler } from '../src/stream/TileScheduler';
import { FrameBuffer } from '../src/stream/FrameBuffer';
import { HeightField, encodeHeightsToRGBA } from '../src/stream/HeightField';
import { SelectionSet } from '../src/model/SelectionSet';
import { validateManifest } from '../src/io/manifest';
import type { SequenceManifest } from '../src/io/manifest';
import type { SerializedTrack } from '../src/model/types';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const session = () => new EditorSession({ raf: () => 0, cancelRaf: () => {} });
const seed = (id = 'a'): SerializedTrack => ({
  meta: { id, label: 'Car', startFrame: 0, endFrame: 10, interpolation: 'linear', source: 'human', attributes: {} },
  keyframes: { frames: [0, 10], pos: [0, 1, 0, 10, 1, 0], yaw: [0, 0], size: [4, 1.5, 2, 4, 1.5, 2] },
});
const manifest = (id = 'sequence'): SequenceManifest => ({ formatVersion: 1, id, fps: 10, frameCount: 11 });
const document = (tracks: unknown[]): SnapshotDocument => ({ formatVersion: 1, sequenceId: 'sequence', frameCount: 11,
  createdAt: '', tracks, geometries: [] } as unknown as SnapshotDocument);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('Document commit invariants', () => {
  it('commits a Session batch once and replays its transaction boundary', () => {
    const s = session(); let events = 0;
    s.store.events.on('changed', () => events++);
    s.history.pushTransaction([new AddTrackCommand(s.store, seed()), new AddTrackCommand(s.store, seed('b'))]);
    expect(events).toBe(1); expect(s.oplog.all()).toHaveLength(1);
    const replay = new TrackStore(); const record = s.oplog.all()[0];
    createCommand(replay, record.name, record.payload as never).apply();
    expect(replay.trackCount).toBe(2);
    s.undo(); expect(s.store.trackCount).toBe(0);
    s.redo(); expect(s.store.trackCount).toBe(2);
    expect(s.oplog.all().map((r) => r.action)).toEqual(['apply', 'undo', 'redo']);
    s.dispose();
  });
  it('rolls back a partially mutating failed command and publishes no intermediate state', () => {
    const s = session(); let events = 0;
    s.store.events.on('changed', () => events++);
    expect(() => s.history.pushTransaction([
      new AddTrackCommand(s.store, seed()),
      { name: 'fault', payload: {}, apply() { s.store.restoreTrack(seed('b')); throw new Error('fault'); }, undo() {} },
    ])).toThrow('fault');
    expect(s.store.trackCount).toBe(0); expect(events).toBe(0);
    expect(s.store.currentVersion).toBe(0); expect(s.history.canUndo).toBe(false); expect(s.oplog.latestSeq).toBe(0);
    s.dispose();
  });
  it.each(['linear', 'hold'] as const)('preserves every resolved frame when splitting %s interpolation', (interpolation) => {
    const store = new TrackStore(); const track = seed(); track.meta.interpolation = interpolation;
    store.restoreTrack(track);
    const before = Array.from({ length: 11 }, (_, f) => store.resolveState('a', f));
    const split = new SplitTrackCommand(store, 'a', 5, 'b'); split.apply();
    for (let f = 0; f <= 10; f++) expect(store.resolveState(f < 5 ? 'a' : 'b', f)?.pos).toEqual(before[f]?.pos);
    split.undo(); expect(store.serializeTrack('a')).toEqual(track);
  });
  it('restores the widened existence interval on undo', () => {
    const s = session(); s.store.restoreTrack(seed());
    s.history.push(new SetKeyframeCommand(s.store, 'a', 20, { pos: { x: 20, y: 1, z: 0 }, yaw: 0, size: { x: 4, y: 1.5, z: 2 } }));
    s.undo(); expect(s.store.getTrack('a')?.meta.endFrame).toBe(10); expect(s.store.resolveState('a', 15)).toBeNull();
    s.redo(); expect(s.store.getTrack('a')?.meta.endFrame).toBe(20); s.dispose();
  });
  it('rejects removing the last keyframe and nonadjacent merges without mutation', () => {
    const store = new TrackStore(); const single = seed();
    single.keyframes = { frames: [0], pos: [0, 1, 0], yaw: [0], size: [4, 1.5, 2] };
    store.restoreTrack(single); store.restoreTrack(seed('b'));
    expect(() => store.removeKeyframe('a', 0)).toThrow('last keyframe');
    expect(() => new MergeTracksCommand(store, 'a', 'b').apply()).toThrow('adjacent');
    expect(store.serializeTrack('a')).toEqual(single);
  });
  it('makes default movement affect only the presented frame keyframe', async () => {
    const s = session(); await s.loadManifest(manifest()); s.store.restoreTrack(seed()); s.selection.select(['a']);
    s.setFrame(5); await flush(); s.nudgeSelection({ x: 2, y: 0, z: 0 });
    expect(s.store.resolveState('a', 5)?.pos.x).toBe(7);
    expect(s.store.resolveState('a', 0)?.pos.x).toBe(0); expect(s.store.resolveState('a', 10)?.pos.x).toBe(10);
    s.undo(); expect(s.store.serializeTrack('a')).toEqual(seed()); s.dispose();
  });
  it('rejects invalid imports atomically and replaces rather than merges valid imports', () => {
    const store = new TrackStore(); store.restoreTrack(seed('old'));
    expect(() => applySnapshot(store, document([seed('new'), { meta: { id: 'bad' } }]))).toThrow();
    expect(store.listTracks().map((r) => r.meta.id)).toEqual(['old']);
    applySnapshot(store, document([seed('new')])); expect(store.listTracks().map((r) => r.meta.id)).toEqual(['new']);
    expect(() => applySnapshot(store, document([seed(), seed()]))).toThrow('Duplicate');
  });
  it('does not reuse imported object IDs', () => {
    const store = new TrackStore(); store.restoreTrack(seed('trk_000001'));
    expect(store.nextTrackId()).toBe('trk_000002');
  });
  it('replaces selection even if the requested ID was already selected', () => {
    const selection = new SelectionSet(); selection.select(['a', 'b']); selection.select(['a']);
    expect(selection.all()).toEqual(['a']); selection.select([]); expect(selection.size).toBe(0);
  });
});

describe('Resource lifecycle', () => {
  it('rejects late cancelled output, disposes once and keeps nonnegative accounting', async () => {
    let complete!: (item: string) => void; let disposed = 0;
    const scheduler = new TileScheduler({ budgetBytes: 100 });
    const result = scheduler.request('a', 0, 10, () => new Promise<string>((r) => { complete = r; }), { dispose: () => disposed++ });
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await flush(); expect(scheduler.stats().reservedBytes).toBe(10);
    scheduler.cancel('a'); complete('late'); await rejection; await flush();
    expect(disposed).toBe(1); expect(scheduler.stats().loadedBytes).toBe(0); expect(scheduler.stats().reservedBytes).toBe(0);
  });
  it('prevents clear from repopulating a cache and permits a fresh load', async () => {
    let complete!: (item: number) => void; let disposed = 0;
    const scheduler = new TileScheduler();
    const buffer = new FrameBuffer({ load: () => new Promise<number>((r) => { complete = r; }), bytes: () => 20, dispose: () => disposed++ }, scheduler);
    const result = buffer.ensure(0); const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await flush(); buffer.clear(); complete(1); await rejected; await flush();
    expect(buffer.stats()).toMatchObject({ cached: 0, pending: 0, bytes: 0 }); expect(disposed).toBe(1);
    const next = buffer.ensure(0); await flush(); complete(2); expect(await next).toBe(2);
    buffer.dispose(); expect(scheduler.stats().loadedBytes).toBe(0); expect(disposed).toBe(2);
  });
  it('corrects actual bytes and invalidates owner caches on global eviction', async () => {
    const scheduler = new TileScheduler({ budgetBytes: 150 });
    const a = new FrameBuffer({ load: async () => 'a', bytes: () => 100, dispose() {} }, scheduler, { estimateBytes: 10 });
    const b = new FrameBuffer({ load: async () => 'b', bytes: () => 100, dispose() {} }, scheduler, { estimateBytes: 10 });
    await a.ensure(0); await b.ensure(0);
    expect(a.get(0)).toBeUndefined(); expect(b.get(0)).toBe('b'); expect(scheduler.stats().loadedBytes).toBe(100);
    a.dispose(); b.dispose();
  });
  it('protects a pinned resource and reports an oversized competing resource', async () => {
    const scheduler = new TileScheduler({ budgetBytes: 100 });
    await scheduler.request('current', 100, 80, async () => 'current', { pinned: true });
    await expect(scheduler.request('extra', 0, 80, async () => 'extra')).rejects.toThrow('budget');
    expect(scheduler.stats().loadedBytes).toBe(80); scheduler.dispose();
  });
  it('awaits an already pending height tile and distinguishes unknown from zero', async () => {
    let complete!: (image: ImageBitmap) => void;
    const field = new HeightField({ originX: 0, originZ: 0, metersPerPixel: 1, width: 1, height: 1,
      tileSize: 1, urlTemplate: 'height.png' }, new TileScheduler(),
      () => new Promise<ImageBitmap>((r) => { complete = r; }),
      () => ({ width: 1, height: 1, data: new Uint8ClampedArray(encodeHeightsToRGBA(new Float32Array([0]))) }));
    expect(field.sampleSync(0, 0)).toBeNull(); field.prefetchAround(0, 0);
    let settled = false; const sampled = field.sample(0, 0).then((v) => { settled = true; return v; });
    await flush(); expect(settled).toBe(false); expect(field.sampleState(0, 0).status).toBe('loading');
    complete({ width: 1, height: 1, close() {} } as ImageBitmap); expect(await sampled).toBe(0);
    expect(field.sampleState(1, 0).status).toBe('missing'); field.dispose();
  });
});

describe('Frame and sequence isolation', () => {
  it('rejects unsupported manifests and incomplete poses before changing the document', async () => {
    expect(() => validateManifest({ ...manifest(), formatVersion: 2 })).toThrow('version');
    const s = session(); await s.loadManifest(manifest()); s.store.restoreTrack(seed());
    await expect(s.loadManifest({ ...manifest('invalid'), egoPoses: [identity] })).rejects.toThrow('trajectory');
    expect(s.manifest?.id).toBe('sequence'); expect(s.store.trackCount).toBe(1); s.dispose();
  });
  it('clears old sequence objects and history when a new manifest commits', async () => {
    const s = session(); await s.loadManifest(manifest()); s.history.push(new AddTrackCommand(s.store, seed()));
    s.selection.select(['a']); await s.loadManifest(manifest('new'));
    expect(s.store.trackCount).toBe(0); expect(s.history.canUndo).toBe(false); expect(s.selection.size).toBe(0); s.dispose();
  });
  it('loads distinct images for distinct camera IDs', async () => {
    const urls: string[] = [];
    const s = new EditorSession({ raf: () => 0, cancelRaf() {}, fetchImage: async (url) => {
      urls.push(url); return { width: 1, height: 1, url, close() {} } as unknown as ImageBitmap;
    } });
    await s.loadManifest({ ...manifest(), cameras: ['left', 'right'].map((id) => ({ id, model: 'pinhole', width: 1, height: 1,
      intrinsics: { fx: 1, fy: 1, cx: 0, cy: 0 }, cameraToEgo: identity, imageTemplate: `${id}/{frame}` })) });
    expect(urls).toContain('left/0'); expect(urls).toContain('right/0');
    expect(s.currentCameraImage('left')).not.toBe(s.currentCameraImage('right')); s.dispose();
  });
  it('keeps the presented frame stable during loading and ignores late seeks', async () => {
    const pending = new Map<string, (b: ArrayBuffer) => void>();
    const cloud = new TextEncoder().encode('FIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nPOINTS 1\nDATA ascii\n0 0 0\n').buffer;
    const s = new EditorSession({ raf: () => 0, cancelRaf() {}, net: { fetchJson: async () => ({}),
      fetchBinary: (url) => new Promise((r) => pending.set(url, r)) } });
    const loading = s.loadManifest({ ...manifest(), pointCloud: { format: 'pcd', urlTemplate: 'pcd/{frame}' } });
    await flush(); pending.get('pcd/0')!(cloud); await loading;
    s.setFrame(1); await flush(); expect(s.frame).toBe(0); expect(s.requestedFrame).toBe(1);
    s.setFrame(2); await flush(); pending.get('pcd/2')!(cloud); await flush(); expect(s.frame).toBe(2);
    pending.get('pcd/1')!(cloud); await flush(); expect(s.frame).toBe(2); s.dispose();
    for (const complete of pending.values()) complete(cloud); await flush();
  });
  it('caches interval coverage across frame changes and invalidates review after editing', async () => {
    const s = session(); await s.loadManifest(manifest()); s.store.restoreTrack(seed()); s.setQA('pass');
    const stats = s.datasetStats(); s.setFrame(5); await flush(); expect(s.datasetStats()).toBe(stats);
    s.selection.select(['a']); s.nudgeSelection({ x: 1, y: 0, z: 0 }); expect(s.qa.status).toBe('pending');
    expect(s.datasetStats().coverage).toBe(1); s.dispose();
  });
});

describe('Input normalization boundaries', () => {
  it('rejects fractional frame indexes before typed-array conversion', () => {
    const store = new TrackStore(); const track = seed(); track.keyframes.frames[0] = 0.5;
    expect(() => applySnapshot(store, document([track]))).toThrow('unique and inside');
    expect(store.trackCount).toBe(0);
  });
  it('rejects determinant-one shear and incomplete camera intrinsics', () => {
    const shear = [...identity]; shear[4] = 0.5;
    expect(() => validateManifest({ ...manifest(), egoPoses: Array(11).fill(shear) })).toThrow('trajectory');
    expect(() => validateManifest({ ...manifest(), cameras: [{ id: 'camera', model: 'pinhole', width: 10, height: 10,
      cameraToEgo: identity, imageTemplate: '/{frame}.png', intrinsics: { fx: 10, fy: 10 } }] })).toThrow('calibration');
  });
});

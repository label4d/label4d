import { describe, expect, it } from 'vitest';
import { TrackStore } from '../src/model/TrackStore';
import { History, OpLog, Transaction } from '../src/command/History';
import {
  AddTrackCommand,
  createCommand,
  MergeTracksCommand,
  SetKeyframeCommand,
  SplitTrackCommand,
  TransformTracksCommand,
} from '../src/command/commands';
import type { SerializedTrack } from '../src/model/types';

function seed(): SerializedTrack {
  return {
    meta: {
      id: 'trk_000001',
      label: 'Car',
      startFrame: 0,
      endFrame: 10,
      interpolation: 'linear',
      source: 'human',
      attributes: {},
    },
    keyframes: {
      frames: [0, 10],
      pos: [0, 1, 0, 10, 1, 0],
      yaw: [0, 0],
      size: [4, 1.5, 2, 4, 1.5, 2],
    },
  };
}

describe('History & commands', () => {
  it('add + undo removes the track', () => {
    const store = new TrackStore();
    const history = new History();
    history.push(new AddTrackCommand(store, seed()));
    expect(store.trackCount).toBe(1);
    history.undo();
    expect(store.trackCount).toBe(0);
    history.redo();
    expect(store.trackCount).toBe(1);
  });

  it('set keyframe undo restores previous state', () => {
    const store = new TrackStore();
    const history = new History();
    history.push(new AddTrackCommand(store, seed()));
    history.push(new SetKeyframeCommand(store, 'trk_000001', 5, { pos: { x: 5, y: 2, z: 3 }, yaw: 1, size: { x: 4, y: 1.5, z: 2 } }));
    expect(store.resolveState('trk_000001', 5)?.pos.z).toBe(3);
    history.undo();
    expect(store.resolveState('trk_000001', 5)?.pos.z).toBe(0); // interpolated from seed keyframes
    history.redo();
    expect(store.resolveState('trk_000001', 5)?.pos.z).toBe(3);
  });

  it('transform over range applies and reverts', () => {
    const store = new TrackStore();
    const history = new History();
    history.push(new AddTrackCommand(store, seed()));
    history.push(
      new TransformTracksCommand(store, ['trk_000001'], 0, Number.MAX_SAFE_INTEGER, { dx: 1, dy: 0, dz: 2, dyaw: 0.5 })
    );
    expect(store.resolveState('trk_000001', 0)?.pos.x).toBe(1);
    expect(store.resolveState('trk_000001', 0)?.pos.z).toBe(2);
    history.undo();
    expect(store.resolveState('trk_000001', 0)?.pos.x).toBe(0);
  });

  it('split then undo restores the original track', () => {
    const store = new TrackStore();
    const history = new History();
    history.push(new AddTrackCommand(store, seed()));
    history.push(new SplitTrackCommand(store, 'trk_000001', 5, 'trk_000002'));
    expect(store.trackCount).toBe(2);
    expect(store.getTrack('trk_000001')?.meta.endFrame).toBe(4);
    expect(store.getTrack('trk_000002')?.keyframes ?? store.getTrack('trk_000002')?.kf).toBeDefined();
    history.undo();
    expect(store.trackCount).toBe(1);
    expect(store.getTrack('trk_000001')?.kf.frames.length).toBe(2);
  });

  it('merge keeps A and absorbs B, undo restores both', () => {
    const store = new TrackStore();
    const history = new History();
    history.push(new AddTrackCommand(store, seed()));
    const second = seed();
    second.meta.id = 'trk_000002';
    second.meta.startFrame = 11;
    second.meta.endFrame = 30;
    second.keyframes.frames = [11, 30];
    second.keyframes.pos = [11, 1, 0, 30, 1, 0];
    history.push(new AddTrackCommand(store, second));
    history.push(new MergeTracksCommand(store, 'trk_000001', 'trk_000002'));
    expect(store.trackCount).toBe(1);
    expect(store.getTrack('trk_000001')?.kf.frames.length).toBe(4);
    history.undo();
    expect(store.trackCount).toBe(2);
  });

  it('transaction is one undo step', () => {
    const store = new TrackStore();
    const history = new History();
    const first = seed();
    const second = seed();
    second.meta.id = 'trk_000002';
    history.pushTransaction([new AddTrackCommand(store, first), new AddTrackCommand(store, second)]);
    expect(store.trackCount).toBe(2);
    history.undo();
    expect(store.trackCount).toBe(0);
    history.redo();
    expect(store.trackCount).toBe(2);
    expect(history.pushTransaction([]) instanceof Transaction).toBe(true);
  });

  it('oplog records and replays through the command registry', () => {
    const store = new TrackStore();
    const history = new History();
    const oplog = new OpLog();
    history.setRecorder((cmd) => oplog.record(cmd.name, cmd.payload));
    history.push(new AddTrackCommand(store, seed()));
    history.push(
      new SetKeyframeCommand(store, 'trk_000001', 10, { pos: { x: 99, y: 1, z: 0 }, yaw: 0, size: { x: 4, y: 1.5, z: 2 } })
    );

    const replayStore = new TrackStore();
    for (const record of oplog.all()) {
      createCommand(replayStore, record.name, record.payload).apply();
    }
    expect(replayStore.trackCount).toBe(1);
    expect(replayStore.resolveState('trk_000001', 10)?.pos.x).toBe(99);
  });
});

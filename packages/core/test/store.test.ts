import { describe, expect, it } from 'vitest';
import { TrackStore } from '../src/model/TrackStore';
import { DEFAULT_LABELS } from '../src/model/types';
import type { SerializedTrack } from '../src/model/types';

function makeTrack(overrides: Partial<SerializedTrack['meta']> = {}, frames: number[] = [10, 20]): SerializedTrack {
  const k = frames.length;
  return {
    meta: {
      id: 'trk_000001',
      label: 'Car',
      startFrame: frames[0],
      endFrame: frames[k - 1],
      interpolation: 'linear',
      source: 'human',
      attributes: {},
      ...overrides,
    },
    keyframes: {
      frames,
      pos: frames.flatMap((_, i) => [i * 10, 1, 0]),
      yaw: frames.map((_, i) => (i === 0 ? 3.0 : -3.0)), // shortest arc crosses PI
      size: frames.flatMap(() => [4, 1.5, 2]),
    },
  };
}

describe('TrackStore', () => {
  it('resolves exact keyframes', () => {
    const store = new TrackStore();
    store.restoreTrack(makeTrack());
    const state = store.resolveState('trk_000001', 20);
    expect(state).not.toBeNull();
    expect(state?.atKeyframe).toBe(true);
    expect(state?.pos.x).toBe(10);
  });

  it('interpolates linearly with shortest-arc yaw', () => {
    const store = new TrackStore();
    store.restoreTrack(makeTrack());
    const state = store.resolveState('trk_000001', 15);
    expect(state?.pos.x).toBeCloseTo(5);
    // yaw 3.0 -> -3.0 must go through PI (shortest arc), not through 0
    expect(Math.abs(state!.yaw)).toBeCloseTo(Math.PI, 5);
    expect(state?.atKeyframe).toBe(false);
  });

  it('holds states in hold mode', () => {
    const store = new TrackStore();
    store.restoreTrack(makeTrack({ interpolation: 'hold' }));
    const state = store.resolveState('trk_000001', 15);
    expect(state?.pos.x).toBe(0); // previous keyframe held
  });

  it('clamps beyond keyframe range but not beyond interval', () => {
    const store = new TrackStore();
    store.restoreTrack(makeTrack({ endFrame: 25 }));
    expect(store.resolveState('trk_000001', 25)?.pos.x).toBe(10);
    expect(store.resolveState('trk_000001', 26)).toBeNull();
    expect(store.resolveState('trk_000001', 9)).toBeNull();
  });

  it('indexes active tracks per frame', () => {
    const store = new TrackStore();
    store.restoreTrack(makeTrack({ id: 'a' }, [0, 10]));
    store.restoreTrack(makeTrack({ id: 'b' }, [10, 20]));
    store.restoreTrack(makeTrack({ id: 'c' }, [15, 30]));
    expect(store.activeTrackIds(5).sort()).toEqual(['a']);
    expect(store.activeTrackIds(10).sort()).toEqual(['a', 'b']);
    expect(store.activeTrackIds(16).sort()).toEqual(['b', 'c']);
    expect(store.activeTrackIds(40)).toEqual([]);
  });

  it('set/remove keyframe round-trips and widens interval', () => {
    const store = new TrackStore();
    store.restoreTrack(makeTrack());
    store.setKeyframe('trk_000001', 30, { pos: { x: 30, y: 1, z: 0 }, yaw: 0, size: { x: 4, y: 1.5, z: 2 } });
    expect(store.getTrack('trk_000001')?.meta.endFrame).toBe(30);
    expect(store.resolveState('trk_000001', 30)?.atKeyframe).toBe(true);
    store.removeKeyframe('trk_000001', 30);
    expect(store.getKeyframes('trk_000001')?.frames.includes(30)).toBe(false);
  });

  it('manages static geometry and per-frame attributes', () => {
    const store = new TrackStore();
    store.addGeometry(
      { id: 'geo_1', kind: 'lane', label: 'Lane', closed: false, startFrame: 0, endFrame: 100, attributes: {} },
      [0, 0, 0, 10, 0, 0]
    );
    expect(store.geometriesAt(50)).toHaveLength(1);
    expect(store.geometriesAt(101)).toHaveLength(0);

    store.restoreTrack(makeTrack());
    store.setFrameAttribute('trk_000001', 10, 'occlusion', '2');
    expect(store.getFrameAttributes('trk_000001', 10)?.occlusion).toBe('2');
    store.setFrameAttribute('trk_000001', 10, 'occlusion', null);
    expect(store.getFrameAttributes('trk_000001', 10)).toBeUndefined();
  });

  it('serializes label defaults usable', () => {
    expect(DEFAULT_LABELS.find((l) => l.name === 'Car')?.dynamic).toBe(true);
  });
});

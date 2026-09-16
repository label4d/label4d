import { describe, expect, it } from 'vitest';
import { EditorSession } from '../src/session/EditorSession';
import { ToolMachine } from '../src/interaction/ToolMachine';
import { vec3 } from '../src/geometry/math';
import { encodeHeightsToRGBA, decodePackedHeights } from '../src/stream/HeightField';

describe('EditorSession picking & tools', () => {
  it('picks a track by vertical ray and rejects misses', () => {
    const session = new EditorSession({
      raf: () => 0,
      cancelRaf: () => undefined,
    });
    session.store.restoreTrack({
      meta: {
        id: 'trk_000001',
        label: 'Car',
        startFrame: 0,
        endFrame: 10,
        interpolation: 'linear',
        source: 'human',
        attributes: {},
      },
      keyframes: { frames: [0, 10], pos: [16.3, 0.8, 0.5, 30, 0.8, 5], yaw: [0.4, 0.4], size: [4.5, 1.6, 2, 4.5, 1.6, 2] },
    });
    const hit = session.pickTrackByRay({ x: 16.3, y: 200, z: 0.5 }, { x: 0, y: -1, z: 0 }, 0);
    expect(hit?.id).toBe('trk_000001');
    const miss = session.pickTrackByRay({ x: 16.3, y: 200, z: 50 }, { x: 0, y: -1, z: 0 }, 0);
    expect(miss).toBeNull();
    session.dispose();
  });

  it('measures distance via the tool machine', () => {
    const tools = new ToolMachine();
    tools.setTool('measure');
    tools.measureKind = 'distance';
    const g = (x: number, z: number) => ({
      world: vec3(x, 0, z),
      screen: { x, y: 0 },
      button: 0,
      shift: false,
      alt: false,
    });
    const ctx = { pickedId: null, vertexHit: null, rotateHandleHit: null, selection: [] };
    tools.pointerDown(g(0, 0), ctx);
    tools.pointerUp(g(0, 0), ctx);
    // 第二次点击凑满两点，直接在 pointerDown 完成测量
    const intent = tools.pointerDown(g(3, 4), ctx);
    expect(intent.type).toBe('measureDone');
    if (intent.type === 'measureDone') {
      expect(ToolMachine.measureValue('distance', intent.points)).toBeCloseTo(5);
    }
  });
});

describe('height packing', () => {
  it('round-trips fixed-point heights', () => {
    const heights = Float32Array.from([-12.34, 0, 0.05, 87.65]);
    const rgba = encodeHeightsToRGBA(heights);
    const decoded = decodePackedHeights({ data: new Uint8ClampedArray(rgba), width: 2, height: 2 });
    heights.forEach((h, i) => expect(decoded[i]).toBeCloseTo(h, 2));
  });
});

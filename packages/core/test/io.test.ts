import { describe, expect, it } from 'vitest';
import { parsePcd } from '../src/io/pcd';
import { applySnapshot, bytesToBase64, base64ToBytes, serializeStore } from '../src/io/snapshot';
import { TrackStore } from '../src/model/TrackStore';

describe('PCD parsing', () => {
  it('parses binary PCD with intensity', () => {
    const count = 3;
    const header = `VERSION 0.7
FIELDS x y z intensity
SIZE 4 4 4 4
TYPE F F F F
COUNT 1 1 1 1
WIDTH ${count}
HEIGHT 1
POINTS ${count}
DATA binary
`;
    const headerBytes = new TextEncoder().encode(header);
    const body = new Uint8Array(count * 16);
    const view = new DataView(body.buffer);
    const values = [
      [1.5, -2.25, 3.125, 0.5],
      [4, 5, 6, 0.25],
      [-7, 8, -9, 0.75],
    ];
    values.forEach((v, i) => {
      view.setFloat32(i * 16, v[0], true);
      view.setFloat32(i * 16 + 4, v[1], true);
      view.setFloat32(i * 16 + 8, v[2], true);
      view.setFloat32(i * 16 + 12, v[3], true);
    });
    const buffer = new Uint8Array(headerBytes.length + body.length);
    buffer.set(headerBytes, 0);
    buffer.set(body, headerBytes.length);

    const frame = parsePcd(buffer.buffer);
    expect(frame.count).toBe(3);
    expect(frame.positions[0]).toBeCloseTo(1.5);
    expect(frame.positions[3]).toBeCloseTo(4);
    expect(frame.positions[6]).toBeCloseTo(-7);
    expect(frame.positions[8]).toBeCloseTo(-9);
    expect(frame.intensity?.[2]).toBeCloseTo(0.75);
  });

  it('parses binary PCD with packed rgb (PCL float bit-pattern)', () => {
    const count = 2;
    const header = `FIELDS x y z rgb
SIZE 4 4 4 4
TYPE F F F F
COUNT 1 1 1 1
POINTS ${count}
DATA binary
`;
    const headerBytes = new TextEncoder().encode(header);
    const body = new Uint8Array(count * 16);
    const view = new DataView(body.buffer);
    const points: Array<[number, number, number, number]> = [
      [1, 2, 3, 0xff0000],
      [4, 5, 6, 0x20ff40],
    ];
    points.forEach(([x, y, z, packed], i) => {
      view.setFloat32(i * 16, x, true);
      view.setFloat32(i * 16 + 4, y, true);
      view.setFloat32(i * 16 + 8, z, true);
      view.setUint32(i * 16 + 12, packed, true); // rgb bits travel in the float slot
    });
    const buffer = new Uint8Array(headerBytes.length + body.length);
    buffer.set(headerBytes, 0);
    buffer.set(body, headerBytes.length);

    const frame = parsePcd(buffer.buffer);
    expect(frame.rgb).not.toBeNull();
    expect(Array.from(frame.rgb!.subarray(0, 3))).toEqual([0xff, 0x00, 0x00]);
    expect(Array.from(frame.rgb!.subarray(3, 6))).toEqual([0x20, 0xff, 0x40]);
    expect(frame.intensity).toBeNull();
  });

  it('parses binary PCD with separate r/g/b uint8 channels', () => {
    const count = 2;
    const header = `FIELDS x y z r g b
SIZE 4 4 4 1 1 1
TYPE F F F U U U
COUNT 1 1 1 1 1 1
POINTS ${count}
DATA binary
`;
    const headerBytes = new TextEncoder().encode(header);
    const body = new Uint8Array(count * 15); // 3*4 + 3*1
    const view = new DataView(body.buffer);
    const colors: Array<[number, [number, number, number]]> = [
      [0, [10, 20, 30]],
      [1.5, [200, 150, 100]],
    ];
    colors.forEach(([x, [r, g, b]], i) => {
      const base = i * 15;
      view.setFloat32(base, x, true);
      view.setUint8(base + 12, r);
      view.setUint8(base + 13, g);
      view.setUint8(base + 14, b);
    });
    const buffer = new Uint8Array(headerBytes.length + body.length);
    buffer.set(headerBytes, 0);
    buffer.set(body, headerBytes.length);

    const frame = parsePcd(buffer.buffer);
    expect(frame.count).toBe(2);
    expect(Array.from(frame.rgb!.subarray(0, 3))).toEqual([10, 20, 30]);
    expect(Array.from(frame.rgb!.subarray(3, 6))).toEqual([200, 150, 100]);
  });

  it('parses ascii PCD', () => {
    const text = `FIELDS x y z
SIZE 4 4 4
TYPE F F F
COUNT 1 1 1
POINTS 2
DATA ascii
0 0 0
1.5 2.5 3.5
`;
    const frame = parsePcd(new TextEncoder().encode(text));
    expect(frame.count).toBe(2);
    expect(frame.positions[5]).toBeCloseTo(3.5);
    expect(frame.intensity).toBeNull();
  });

  it('rejects binary_compressed explicitly', () => {
    const text = 'FIELDS x y z\nDATA binary_compressed\n';
    expect(() => parsePcd(new TextEncoder().encode(text))).toThrow(/binary_compressed/);
  });
});

describe('snapshot serialization', () => {
  it('base64 round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 42]);
    const decoded = base64ToBytes(bytesToBase64(bytes));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('accepts plain-array keyframes as well as the binary form', () => {
    const doc = {
      formatVersion: 1 as const,
      sequenceId: 'plain',
      frameCount: 10,
      createdAt: 'now',
      tracks: [
        {
          meta: {
            id: 'trk_plain',
            label: 'Car',
            startFrame: 0,
            endFrame: 2,
            interpolation: 'linear' as const,
            source: 'human' as const,
            attributes: {},
          },
          // plain arrays instead of base64 columns
          kf: {
            count: 3,
            frames: [0, 1, 2],
            pos: [0, 1, 0, 5, 1, 0, 9, 1, 0],
            yaw: [0, 0.5, 1],
            size: [4, 1.5, 2, 4, 1.5, 2, 4, 1.5, 2],
          },
        },
      ],
      geometries: [],
    };
    const store = new TrackStore();
    applySnapshot(store, doc as unknown as SnapshotDocument);
    expect(store.trackCount).toBe(1);
    expect(store.resolveState('trk_plain', 1)?.pos.x).toBeCloseTo(5);
  });

  it('serialize + apply restores the document', () => {
    const source = new TrackStore();
    source.restoreTrack({
      meta: {
        id: 'trk_000001',
        label: 'Car',
        startFrame: 0,
        endFrame: 5,
        interpolation: 'linear',
        source: 'human',
        attributes: { color: 'red' },
      },
      keyframes: { frames: [0, 5], pos: [0, 1, 0, 5, 1, 0], yaw: [0.5, 0.5], size: [4, 1.5, 2, 4, 1.5, 2] },
      frameAttributes: [{ frame: 0, attrs: { occlusion: '1' } }],
    });
    source.addGeometry(
      { id: 'geo_1', kind: 'curb', label: 'Curb', closed: false, startFrame: 0, endFrame: 5, attributes: {} },
      [0, 0, 0, 1, 0, 1]
    );

    const doc = serializeStore(source, { sequenceId: 's1', frameCount: 10 });
    const target = new TrackStore();
    applySnapshot(target, doc);

    expect(target.trackCount).toBe(1);
    expect(target.getTrack('trk_000001')?.kf.frames.length).toBe(2);
    expect(target.getTrack('trk_000001')?.meta.attributes.color).toBe('red');
    expect(target.getFrameAttributes('trk_000001', 0)?.occlusion).toBe('1');
    expect(target.resolveState('trk_000001', 2)?.pos.x).toBeCloseTo(2);
    expect(target.geometryCount).toBe(1);
  });
});

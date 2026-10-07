import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CameraProjector, EgoTrack } from '../src/projection/projection';
import { parsePcd } from '../src/io/pcd';
import { validateManifest } from '../src/io/manifest';

const source = resolve('../../fixtures/r-mini');
const output = resolve('../../apps/web-ui/public/kitti-camera');
describe.skipIf(!existsSync(`${output}/manifest.json`))('Real camera preview coordinate conversion', () => {
  it.each([0, 12, 199])('preserves camera pixels for same-frame lidar in frame %s', (frame) => {
    const original = JSON.parse(readFileSync(`${source}/manifest.json`, 'utf8'));
    const converted = validateManifest(JSON.parse(readFileSync(`${output}/manifest.json`, 'utf8')));
    const sensor = original.sensors.find((s: { type: string }) => s.type === 'camera');
    const config = { ...converted.cameras![0], cameraToEgo: sensor.T_ego_from_sensor };
    const a = CameraProjector.create(config, new EgoTrack(new Float64Array(original.pose.frames.flatMap((f: { T_world_from_ego: number[] }) => f.T_world_from_ego)), converted.frameCount));
    const b = CameraProjector.create(converted.cameras![0], new EgoTrack(new Float64Array((converted.egoPoses as number[][]).flat()), converted.frameCount));
    const cloud = (dir: string) => { const bytes = readFileSync(`${dir}/pcd/${frame}.pcd`); return parsePcd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); };
    const old = cloud(source), next = cloud(output);
    expect(next.count).toBe(old.count);
    let valid = 0;
    for (let i = 0; i < old.count; i += 997) {
      const at = i * 3;
      const p = { x: old.positions[at], y: old.positions[at + 1], z: old.positions[at + 2] };
      expect(next.positions[at]).toBe(p.x); expect(next.positions[at + 1]).toBe(p.z); expect(next.positions[at + 2]).toBe(-p.y);
      // Fresh projectors avoid shared temporary-matrix state between cameras.
      const aa = CameraProjector.create(a.config, new EgoTrack(new Float64Array(original.pose.frames.flatMap((f: { T_world_from_ego: number[] }) => f.T_world_from_ego)), converted.frameCount));
      const bb = CameraProjector.create(b.config, new EgoTrack(new Float64Array((converted.egoPoses as number[][]).flat()), converted.frameCount));
      const before = aa.projectPoint(p, frame);
      const after = bb.projectPoint({ x: p.x, y: p.z, z: -p.y }, frame);
      expect(after.valid).toBe(before.valid);
      if (before.valid) { valid++; expect(after.x).toBeCloseTo(before.x, 6); expect(after.y).toBeCloseTo(before.y, 6); }
    }
    expect(valid).toBeGreaterThan(0);
  });
});

import { expect, it } from 'vitest';
import { CameraProjector, EgoTrack } from '../src/projection/projection';

it('keeps each camera projection cached independently when views alternate at the same frame', () => {
  const config = { id: 'a', model: 'pinhole' as const, width: 100, height: 100, intrinsics: { fx: 100, fy: 100, cx: 50, cy: 50 },
    cameraToEgo: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], imageTemplate: '' };
  const a = CameraProjector.create(config, EgoTrack.identity(2));
  const transform = [...config.cameraToEgo]; transform[12] = 2;
  const b = CameraProjector.create({ ...config, id: 'b', cameraToEgo: transform }, EgoTrack.identity(2));
  const p = { x: 0, y: 0, z: 10 };
  expect(a.projectPoint(p, 0).x).toBe(50);
  expect(b.projectPoint(p, 0).x).toBe(30);
  expect(a.projectPoint(p, 0).x).toBe(50);
  expect(b.projectPoint(p, 1).x).toBe(30);
  expect(a.worldToCamera(p, 0)).toEqual(p);
  expect(b.projectPoint(p, 0).x).toBe(30);
});

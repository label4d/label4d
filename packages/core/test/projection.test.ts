import { describe, expect, it } from 'vitest';
import {
  CameraProjector,
  EgoTrack,
  boxCorners,
  composeBoxMatrix,
  createProjectionModel,
  convexHull,
  lerpYaw,
  normalizeYaw,
  pointInPolygon,
  rayGround,
  rayOBB,
} from '../src';

describe('geometry math', () => {
  it('normalizes and lerps yaw across the branch cut', () => {
    expect(normalizeYaw(Math.PI + 0.1)).toBeLessThan(-Math.PI + 0.2);
    const mid = lerpYaw(3.0, -3.0, 0.5);
    expect(Math.abs(mid)).toBeCloseTo(Math.PI, 5);
  });

  it('ray-casts an OBB', () => {
    const hit = rayOBB(
      { x: -10, y: 0.75, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0.75, z: 0 },
      0.5,
      { x: 4, y: 1.5, z: 2 }
    );
    expect(hit).not.toBeNull();
    expect(hit!).toBeGreaterThan(6);
    const miss = rayOBB(
      { x: -10, y: 0.75, z: 50 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0.75, z: 0 },
      0,
      { x: 4, y: 1.5, z: 2 }
    );
    expect(miss).toBeNull();
  });

  it('composes box matrices three-compatible', () => {
    const m = new Float32Array(16);
    composeBoxMatrix({ x: 1, y: 2, z: 3 }, 0, { x: 4, y: 5, z: 6 }, m);
    // translation in column 3
    expect(m[12]).toBe(1);
    expect(m[13]).toBe(2);
    expect(m[14]).toBe(3);
    // scale in diagonal
    expect(m[0]).toBeCloseTo(4);
    expect(m[5]).toBeCloseTo(5);
    expect(m[10]).toBeCloseTo(6);
  });

  it('computes corners and hull containment', () => {
    const corners = new Float64Array(24);
    boxCorners({ x: 0, y: 1, z: 0 }, 0, { x: 2, y: 2, z: 2 }, corners);
    expect(corners[0]).toBeCloseTo(-1);
    expect(corners[1]).toBeCloseTo(0);
    const hull = convexHull([0, 0, 4, 0, 4, 4, 0, 4, 2, 2]);
    expect(hull.length).toBe(8);
    expect(pointInPolygon(1, 1, hull, hull.length / 2)).toBe(true);
    expect(pointInPolygon(9, 9, hull, hull.length / 2)).toBe(false);
  });

  it('intersects the ground plane', () => {
    const hit = rayGround({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 1 }, 0);
    expect(hit?.z).toBeCloseTo(10);
    expect(rayGround({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 })).toBeNull();
  });
});

describe('projection models', () => {
  it('projects pinhole points to expected pixels', () => {
    const model = createProjectionModel('pinhole', { fx: 800, fy: 800, cx: 480, cy: 270 }, []);
    const p = model.project({ x: 0, y: 0, z: 10 });
    expect(p.x).toBeCloseTo(480);
    expect(p.y).toBeCloseTo(270);
    const off = model.project({ x: 1, y: 0, z: 10 });
    expect(off.x).toBeCloseTo(560); // fx * 0.1 + cx
  });

  it('pinhole distortion moves border points outward with positive k1', () => {
    const plain = createProjectionModel('pinhole', { fx: 800, fy: 800, cx: 480, cy: 270 }, []);
    const distorted = createProjectionModel('pinhole', { fx: 800, fy: 800, cx: 480, cy: 270 }, [0.2]);
    const point = { x: 0.4, y: 0.2, z: 1 };
    const a = plain.project(point);
    const b = distorted.project(point);
    expect(Math.hypot(b.x - 480, b.y - 270)).toBeGreaterThan(Math.hypot(a.x - 480, a.y - 270));
  });

  it('fisheye equidistant compresses large angles (r < pinhole r)', () => {
    const fisheye = createProjectionModel('fisheye_equidistant', { fx: 800, fy: 800, cx: 480, cy: 270 }, []);
    const pinhole = createProjectionModel('pinhole', { fx: 800, fy: 800, cx: 480, cy: 270 }, []);
    const wide = { x: 2, y: 0, z: 1 }; // ~63.4 degrees off-axis
    const f = fisheye.project(wide);
    const p = pinhole.project(wide);
    expect(f.x - 480).toBeLessThan(p.x - 480);
    // and matches atan model exactly for zero distortion: r_px = f * atan(r)
    expect(f.x - 480).toBeCloseTo(800 * Math.atan(2), 3);
  });

  it('projector chains ego pose and extrinsics', () => {
    // ego at (10, 0, 0); camera: +x_cam=ego -z... built so camera forward (+z_cam) = ego +x, y_cam down
    const pose = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]);
    const ego = new EgoTrack(pose, 1);
    const projector = CameraProjector.create(
      {
        id: 'cam',
        model: 'pinhole',
        width: 960,
        height: 540,
        intrinsics: { fx: 800, fy: 800, cx: 480, cy: 270 },
        // columns: x_cam->ego(0,0,1), y_cam->ego(0,-1,0), z_cam->ego(1,0,0), cam origin at (0,1.5,0) in ego
        cameraToEgo: [0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 1.5, 0, 1],
      },
      ego
    );
    // a point 10m ahead of the ego in world coords
    const px = projector.projectPoint({ x: 20, y: 0, z: 0 }, 0);
    expect(px.valid).toBe(true);
    expect(px.x).toBeCloseTo(480); // straight ahead, centered
    expect(px.y).toBeCloseTo(270 + 800 * 0.15); // 1.5m below optical axis at 10m
    // behind the camera
    const behind = projector.projectPoint({ x: 0, y: 0, z: 0 }, 0);
    expect(behind.valid).toBe(false);
  });

  it('projectBox produces a hull that contains the projected center', () => {
    const ego = EgoTrack.identity(1);
    const projector = CameraProjector.create(
      {
        id: 'cam',
        model: 'fisheye_equidistant',
        width: 960,
        height: 540,
        intrinsics: { fx: 420, fy: 420, cx: 480, cy: 270 },
        distortion: [-0.01, 0.005, 0, 0],
        cameraToEgo: [0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 1.5, 0, 1],
      },
      ego
    );
    const projection = projector.projectBox({ x: 8, y: 0.75, z: 2 }, 0.3, { x: 4.5, y: 1.6, z: 2 }, 0);
    expect(projection.visible).toBe(true);
    const center = projector.projectPoint({ x: 8, y: 0.75, z: 2 }, 0);
    expect(pointInPolygon(center.x, center.y, projection.hull, projection.hull.length / 2)).toBe(true);
  });
});

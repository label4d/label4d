import {
  boxCorners,
  convexHull,
  mat4Invert,
  mat4Multiply,
  transformPoint,
} from '../geometry/math';
import type { SourceRectangle } from '../dataset/DatasetProvider';
import type { Vec3 } from '../geometry/math';
import type { CameraConfig, CameraModelType } from '../io/manifest';

// ---- per-frame ego trajectory ----

export class EgoTrack {
  constructor(
    private readonly poses: Float64Array, // n * 16, ego -> world, column-major
    readonly count: number
  ) {}

  static identity(frameCount: number): EgoTrack {
    const poses = new Float64Array(frameCount * 16);
    for (let i = 0; i < frameCount; i++) {
      poses[i * 16] = 1;
      poses[i * 16 + 5] = 1;
      poses[i * 16 + 10] = 1;
      poses[i * 16 + 15] = 1;
    }
    return new EgoTrack(poses, frameCount);
  }

  poseAt(frame: number): Float64Array {
    const f = Math.max(0, Math.min(this.count - 1, Math.round(frame)));
    return this.poses.subarray(f * 16, f * 16 + 16);
  }

  positionAt(frame: number): Vec3 {
    const m = this.poseAt(frame);
    return { x: m[12], y: m[13], z: m[14] };
  }

  /** ego -> world at frame */
  egoToWorld(frame: number, out: Float64Array): void {
    out.set(this.poseAt(frame));
  }
}

// ---- projection models ----

export interface PixelPoint {
  x: number;
  y: number;
  valid: boolean;
}

export interface ProjectionModel {
  readonly type: CameraModelType | string;
  /** camera-space point -> pixel; valid=false when behind the camera */
  project(cameraPoint: Vec3): PixelPoint;
}

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

class PinholeModel implements ProjectionModel {
  readonly type = 'pinhole';
  private readonly k1: number;
  private readonly k2: number;
  private readonly p1: number;
  private readonly p2: number;
  private readonly k3: number;

  constructor(
    private readonly intr: Intrinsics,
    distortion?: number[]
  ) {
    this.k1 = distortion?.[0] ?? 0;
    this.k2 = distortion?.[1] ?? 0;
    this.p1 = distortion?.[2] ?? 0;
    this.p2 = distortion?.[3] ?? 0;
    this.k3 = distortion?.[4] ?? 0;
  }

  project(p: Vec3): PixelPoint {
    if (p.z <= 1e-6) return { x: 0, y: 0, valid: false };
    const xn = p.x / p.z;
    const yn = p.y / p.z;
    const r2 = xn * xn + yn * yn;
    const radial = 1 + this.k1 * r2 + this.k2 * r2 * r2 + this.k3 * r2 * r2 * r2;
    const xd = xn * radial + 2 * this.p1 * xn * yn + this.p2 * (r2 + 2 * xn * xn);
    const yd = yn * radial + this.p1 * (r2 + 2 * yn * yn) + 2 * this.p2 * xn * yn;
    return { x: this.intr.fx * xd + this.intr.cx, y: this.intr.fy * yd + this.intr.cy, valid: true };
  }
}

abstract class FisheyeModel implements ProjectionModel {
  abstract readonly type: string;
  protected readonly k: number[];

  constructor(
    protected readonly intr: Intrinsics,
    distortion?: number[]
  ) {
    this.k = [distortion?.[0] ?? 0, distortion?.[1] ?? 0, distortion?.[2] ?? 0, distortion?.[3] ?? 0];
  }

  /** theta_d / r mapping per model; r = sqrt(xn^2 + yn^2), theta = atan(r) */
  protected abstract thetaScale(theta: number): number;

  project(p: Vec3): PixelPoint {
    const depth = this.depthOf(p);
    if (depth <= 1e-6) return { x: 0, y: 0, valid: false };
    const xn = p.x / depth;
    const yn = p.y / depth;
    const r = Math.hypot(xn, yn);
    const theta = Math.atan(r);
    const t2 = theta * theta;
    const thetaD =
      theta * (1 + this.k[0] * t2 + this.k[1] * t2 * t2 + this.k[2] * t2 * t2 * t2 + this.k[3] * t2 * t2 * t2 * t2);
    // pixel radius = thetaScale(theta_d); normalized pinhole radius = r
    const factor = r > 1e-9 ? this.thetaScale(thetaD) / r : 1;
    return { x: this.intr.fx * xn * factor + this.intr.cx, y: this.intr.fy * yn * factor + this.intr.cy, valid: true };
  }

  protected depthOf(p: Vec3): number {
    return p.z;
  }
}

class FisheyeEquidistantModel extends FisheyeModel {
  readonly type = 'fisheye_equidistant';
  protected thetaScale(thetaD: number): number {
    return thetaD;
  }
}

class FisheyeEquisolidModel extends FisheyeModel {
  readonly type = 'fisheye_equisolid';
  protected thetaScale(thetaD: number): number {
    return 2 * Math.sin(thetaD / 2);
  }
}

export type ProjectionModelFactory = (intr: Intrinsics, distortion?: number[]) => ProjectionModel;

const registry = new Map<string, ProjectionModelFactory>();

export function registerProjectionModel(name: string, factory: ProjectionModelFactory): void {
  registry.set(name, factory);
}

export function createProjectionModel(
  type: CameraModelType | string,
  intr: Intrinsics,
  distortion?: number[]
): ProjectionModel {
  if (type === 'pinhole') return new PinholeModel(intr, distortion);
  if (type === 'fisheye_equidistant') return new FisheyeEquidistantModel(intr, distortion);
  if (type === 'fisheye_equisolid') return new FisheyeEquisolidModel(intr, distortion);
  const factory = registry.get(type);
  if (factory) return factory(intr, distortion);
  throw new Error(`Unknown projection model: ${type}`);
}

// ---- per-camera projector ----

export interface BoxProjection {
  /** 8 corner pixels, flat [x0,y0,...x7,y7] */
  pixels: number[];
  /** convex hull of visible corners, flat [x,y,...] — hit-test region */
  hull: number[];
  /** camera-space depth per corner (<=0 = behind camera) */
  cornerDepths: number[];
  visible: boolean;
  minDepth: number;
}

export interface VerticesProjection {
  pixels: number[];
  valid: boolean[];
}

const tmpA = new Float64Array(16);
const tmpB = new Float64Array(16);
const tmpPoint: Vec3 = { x: 0, y: 0, z: 0 };

export class CameraProjector {
  /** Optional per-image world pose and official reference overlays. */
  poseProvider: ((frame: number) => readonly number[]) | null = null;
  sourceBoxes: ((frame: number) => readonly SourceRectangle[]) | null = null;
  sourceCameraId: number | null = null;
  private cachedFrame = -1;
  private readonly worldToCam = new Float64Array(16);

  constructor(
    readonly config: CameraConfig,
    private readonly ego: EgoTrack | null,
    private readonly model: ProjectionModel
  ) {}

  static create(config: CameraConfig, ego: EgoTrack | null): CameraProjector {
    return new CameraProjector(config, ego, createProjectionModel(config.model, config.intrinsics, config.distortion));
  }

  private ensureFrame(frame: number): void {
    if (this.cachedFrame === frame) return;
    if (this.poseProvider) {
      mat4Invert(this.poseProvider(frame), this.worldToCam); this.cachedFrame = frame; return;
    }
    const camToEgo = this.config.cameraToEgo;
    mat4Invert(camToEgo, tmpA); // ego -> camera
    if (this.ego) {
      mat4Invert(this.ego.poseAt(frame), tmpB); // world -> ego
      mat4Multiply(tmpA, tmpB, this.worldToCam); // world -> camera
    } else {
      this.worldToCam.set(tmpA);
    }
    this.cachedFrame = frame;
  }

  worldToCamera(world: Vec3, frame: number): Vec3 {
    this.ensureFrame(frame);
    transformPoint(this.worldToCam, world, tmpPoint);
    return { x: tmpPoint.x, y: tmpPoint.y, z: tmpPoint.z };
  }

  projectPoint(world: Vec3, frame: number): PixelPoint & { depth: number } {
    this.ensureFrame(frame);
    transformPoint(this.worldToCam, world, tmpPoint);
    const px = this.model.project(tmpPoint);
    return { ...px, depth: tmpPoint.z };
  }

  projectBox(pos: Vec3, yaw: number, size: Vec3, frame: number): BoxProjection {
    this.ensureFrame(frame);
    const corners = new Float64Array(24);
    boxCorners(pos, yaw, size, corners);
    const pixels: number[] = [];
    const hullInput: number[] = [];
    const cornerDepths: number[] = [];
    let visible = false;
    let minDepth = Infinity;
    for (let i = 0; i < 8; i++) {
      transformPoint(this.worldToCam, { x: corners[i * 3], y: corners[i * 3 + 1], z: corners[i * 3 + 2] }, tmpPoint);
      const cam = { x: tmpPoint.x, y: tmpPoint.y, z: tmpPoint.z };
      if (cam.z > 0) visible = true;
      cornerDepths.push(cam.z);
      minDepth = Math.min(minDepth, cam.z);
      const px = this.model.project(cam);
      pixels.push(px.x, px.y);
      if (cam.z > 1e-6) hullInput.push(px.x, px.y);
    }
    return { pixels, hull: convexHull(hullInput), cornerDepths, visible: visible && hullInput.length >= 3, minDepth };
  }

  projectVertices(vertices: Float32Array, frame: number): VerticesProjection {
    this.ensureFrame(frame);
    const n = vertices.length / 3;
    const pixels: number[] = [];
    const valid: boolean[] = [];
    for (let i = 0; i < n; i++) {
      transformPoint(this.worldToCam, { x: vertices[i * 3], y: vertices[i * 3 + 1], z: vertices[i * 3 + 2] }, tmpPoint);
      const px = this.model.project(tmpPoint);
      pixels.push(px.x, px.y);
      valid.push(px.valid);
    }
    return { pixels, valid };
  }
}

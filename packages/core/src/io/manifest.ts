import type { LabelDef } from '../model/types';
import { DEFAULT_LABELS } from '../model/types';

export type CameraModelType = 'pinhole' | 'fisheye_equidistant' | 'fisheye_equisolid';

export interface CameraConfig {
  id: string;
  model: CameraModelType;
  width: number;
  height: number;
  intrinsics: { fx: number; fy: number; cx: number; cy: number };
  /**
   * pinhole: [k1, k2, p1, p2, k3] (Brown-Conrady)
   * fisheye: [k1, k2, k3, k4] (theta polynomial, OpenCV fisheye convention)
   */
  distortion?: number[];
  /** 4x4 column-major, camera -> ego */
  cameraToEgo: number[];
  /** per-frame image URL, `{frame}` substituted */
  imageTemplate: string;
}

export interface PointCloudSource {
  urlTemplate: string;
  format: 'pcd';
  approxBytesPerFrame?: number;
}

export interface TilesetConfig {
  /** world coords of the image top-left corner (ground plane XZ) */
  originX: number;
  originZ: number;
  /** world meters per pixel at level 0; image +y maps to +z */
  metersPerPixel: number;
  /** full-resolution pixel dimensions */
  width: number;
  height: number;
  tileSize: number;
  /** "{level}/{x}/{y}.png" */
  urlTemplate: string;
}

export interface BevImageConfig {
  url: string;
  originX: number;
  originZ: number;
  metersPerPixel: number;
  width: number;
  height: number;
}

export interface HeightSource {
  /** 单张固定尺寸图片（BEV 底图 / 高度图模式），配合 extent 字段 */
  url?: string;
  /** 图片覆盖范围（世界坐标） */
  originX?: number;
  originZ?: number;
  metersPerPixel?: number;
  width?: number;
  height?: number;
  /** 瓦片金字塔模式 */
  tileset?: TilesetConfig;
}

export interface SequenceManifest {
  formatVersion: 1;
  id: string;
  fps: number;
  frameCount: number;
  /** inline n x 16 (ego -> world, column-major) or URL to a JSON file of the same shape */
  egoPoses?: string | number[][];
  pointCloud?: PointCloudSource;
  bev?: { tileset?: TilesetConfig; image?: BevImageConfig };
  height?: HeightSource;
  cameras?: CameraConfig[];
  potree?: { url: string };
  labels?: LabelDef[];
  qa?: { status: 'pending' | 'pass' | 'reject'; notes?: string };
}

export function parseEgoPoses(data: unknown, frameCount: number): Float64Array | null {
  if (!Array.isArray(data) || data.length !== frameCount) return null;
  const out = new Float64Array(frameCount * 16);
  for (let i = 0; i < data.length; i++) {
    const m = data[i];
    if (!validTransform(m)) return null;
    out.set(m, i * 16);
  }
  return out;
}

function validTransform(m: unknown): m is number[] {
  if (!Array.isArray(m) || m.length !== 16 || !m.every(Number.isFinite)) return false;
  if (Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) + Math.abs(m[15] - 1) > 1e-5) return false;
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (Math.abs(det - 1) >= 1e-3) return false;
  for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) {
    const dot = m[a * 4] * m[b * 4] + m[a * 4 + 1] * m[b * 4 + 1] + m[a * 4 + 2] * m[b * 4 + 2];
    if (Math.abs(dot - (a === b ? 1 : 0)) > 1e-3) return false;
  }
  return true;
}

/** Runtime gate: v1 is explicit Y-up; never reinterpret a v2 Z-up document. */
export function validateManifest(input: unknown): SequenceManifest {
  const m = input as SequenceManifest;
  if (!m || m.formatVersion !== 1) throw new Error('Unsupported manifest version; v2 migration is not yet enabled');
  if (!m.id || typeof m.id !== 'string' || !Number.isSafeInteger(m.frameCount) || m.frameCount < 1 || !Number.isFinite(m.fps) || m.fps <= 0) {
    throw new Error('Invalid sequence identity or time axis');
  }
  if (m.pointCloud && (m.pointCloud.format !== 'pcd' || !m.pointCloud.urlTemplate)) throw new Error('Unsupported point cloud source');
  const ids = new Set<string>();
  for (const c of m.cameras ?? []) {
    if (!c.id || ids.has(c.id) || !['pinhole', 'fisheye_equidistant', 'fisheye_equisolid'].includes(c.model) ||
        !Number.isSafeInteger(c.width) || c.width <= 0 || !Number.isSafeInteger(c.height) || c.height <= 0 ||
        !c.imageTemplate || !validTransform(c.cameraToEgo) || !c.intrinsics ||
        ![c.intrinsics.fx, c.intrinsics.fy, c.intrinsics.cx, c.intrinsics.cy].every(Number.isFinite) || c.intrinsics.fx <= 0 || c.intrinsics.fy <= 0 ||
        (c.distortion && !c.distortion.every(Number.isFinite))) throw new Error('Invalid camera calibration');
    ids.add(c.id);
  }
  if (m.egoPoses && typeof m.egoPoses !== 'string' && !parseEgoPoses(m.egoPoses, m.frameCount)) throw new Error('Invalid ego trajectory');
  return structuredClone(m);
}

export function manifestLabels(manifest: SequenceManifest): LabelDef[] {
  return manifest.labels && manifest.labels.length > 0 ? manifest.labels : DEFAULT_LABELS;
}

export function substituteFrame(template: string, frame: number): string {
  return template.replace(/\{frame\}/g, String(frame));
}

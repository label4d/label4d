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

export interface HeightSource {
  /** single RGBA-packed float32 PNG covering the tileset extent */
  url?: string;
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
  bev?: { tileset: TilesetConfig };
  height?: HeightSource;
  cameras?: CameraConfig[];
  potree?: { url: string };
  labels?: LabelDef[];
  qa?: { status: 'pending' | 'pass' | 'reject'; notes?: string };
}

export function parseEgoPoses(data: unknown, frameCount: number): Float64Array | null {
  if (!Array.isArray(data)) return null;
  const n = Math.min(data.length, frameCount);
  const out = new Float64Array(n * 16);
  for (let i = 0; i < n; i++) {
    const m = data[i];
    if (!Array.isArray(m) || m.length !== 16) continue;
    for (let j = 0; j < 16; j++) out[i * 16 + j] = m[j];
  }
  return n > 0 ? out : null;
}

export function manifestLabels(manifest: SequenceManifest): LabelDef[] {
  return manifest.labels && manifest.labels.length > 0 ? manifest.labels : DEFAULT_LABELS;
}

export function substituteFrame(template: string, frame: number): string {
  return template.replace(/\{frame\}/g, String(frame));
}

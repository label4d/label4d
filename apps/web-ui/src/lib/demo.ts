import type { NetClient } from '@labelfaster/core';
import type { SequenceManifest } from '@labelfaster/core';
import { parsePcd } from '@labelfaster/core';
import type { PointCloudFrame } from '@labelfaster/core';
import type { AssistAdapter, AssistCandidate } from '@labelfaster/core';

/**
 * Self-contained synthetic 4D sequence so the app is verifiable with zero
 * external data: 300 frames @10fps, circular ego path, moving box objects in
 * a generated point cloud, synthetic camera image. URLs use demo:// scheme,
 * served by the injected NetClient / ImageFetcher below.
 */

export const DEMO_FRAME_COUNT = 300;
export const DEMO_FPS = 10;

interface DemoMover {
  label: string;
  size: [number, number, number]; // l,h,w
  path: (t: number) => { x: number; z: number; yaw: number };
}

const movers: DemoMover[] = [
  {
    label: 'Car',
    size: [4.5, 1.6, 2.0],
    path: (t) => ({ x: 12 - t * 0.1, z: -4 + Math.sin(t * 0.15) * 2, yaw: Math.PI }),
  },
  {
    label: 'Pedestrian',
    size: [0.7, 1.75, 0.7],
    path: (t) => ({ x: -6 + Math.sin(t * 0.05) * 6, z: 6 + t * 0.03, yaw: Math.PI / 2 }),
  },
  {
    label: 'Car',
    size: [4.5, 1.6, 2.0],
    path: (t) => ({ x: -14, z: -10 + t * 0.06, yaw: 0.3 }),
  },
];

export function demoEgoPoses(): number[][] {
  const poses: number[][] = [];
  for (let f = 0; f < DEMO_FRAME_COUNT; f++) {
    const t = f / DEMO_FPS;
    const angle = t * 0.05;
    const x = Math.cos(angle) * 30;
    const z = Math.sin(angle) * 30;
    const yaw = angle + Math.PI / 2;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // column-major ego->world (rotation about Y + translation)
    poses.push([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, x, 0, z, 1]);
  }
  return poses;
}

export function buildDemoManifest(): SequenceManifest {
  return {
    formatVersion: 1,
    id: 'demo_sequence',
    fps: DEMO_FPS,
    frameCount: DEMO_FRAME_COUNT,
    egoPoses: demoEgoPoses(),
    pointCloud: { urlTemplate: 'demo://pointcloud/{frame}', format: 'pcd', approxBytesPerFrame: 200_000 },
    cameras: [
      {
        id: 'cam_front',
        model: 'pinhole',
        width: 960,
        height: 540,
        intrinsics: { fx: 800, fy: 800, cx: 480, cy: 270 },
        distortion: [0.02, -0.01, 0, 0, 0],
        cameraToEgo: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 1.4, 0, 1],
        imageTemplate: 'demo://camera/{frame}',
      },
      {
        id: 'cam_wide',
        model: 'fisheye_equidistant',
        width: 960,
        height: 540,
        intrinsics: { fx: 420, fy: 420, cx: 480, cy: 270 },
        distortion: [-0.01, 0.005, 0, 0],
        cameraToEgo: [1, 0, 0, 0, 0, 0.7, 0.7, 0, 0, -0.7, 0.7, 0, 0, 1.6, 0, 1],
        imageTemplate: 'demo://camera/{frame}',
      },
    ],
    labels: undefined,
  };
}

function pushBoxPoints(
  out: number[],
  outRgb: number[],
  color: [number, number, number],
  cx: number,
  cz: number,
  yaw: number,
  size: [number, number, number],
  seed: number
): void {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const c = Math.cos(yaw);
  const n = Math.sin(yaw); // note: world yaw -> x' = x c + z s, z' = -x s + z c
  for (let i = 0; i < 260; i++) {
    const lx = (rand() - 0.5) * size[0];
    const lz = (rand() - 0.5) * size[2];
    const ly = rand() * size[1];
    const x = cx + lx * c + lz * n;
    const z = cz + -lx * n + lz * c;
    const shade = 0.65 + rand() * 0.35; // per-point brightness jitter
    out.push(x, ly, z);
    outRgb.push(
      Math.min(255, Math.round(color[0] * shade)),
      Math.min(255, Math.round(color[1] * shade)),
      Math.min(255, Math.round(color[2] * shade))
    );
  }
}

const GROUND_RGB: [number, number, number] = [96, 104, 118];
const MOVER_RGB: Array<[number, number, number]> = [
  [86, 148, 255], // Car (blue)
  [96, 240, 128], // Pedestrian (green)
  [255, 168, 84], // Car (orange)
];

function synthFrame(frame: number): PointCloudFrame {
  const pts: number[] = [];
  const rgbBytes: number[] = [];
  // ground grid
  let s = frame + 7;
  for (let i = 0; i < 5200; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const x = ((s >> 8) % 10000) / 10000 * 80 - 40;
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const z = ((s >> 8) % 10000) / 10000 * 80 - 40;
    pts.push(x, 0, z);
    const shade = 0.8 + (((s >> 4) % 100) / 100) * 0.4;
    rgbBytes.push(
      Math.min(255, Math.round(GROUND_RGB[0] * shade)),
      Math.min(255, Math.round(GROUND_RGB[1] * shade)),
      Math.min(255, Math.round(GROUND_RGB[2] * shade))
    );
  }
  // moving objects
  movers.forEach((mover, mi) => {
    const p = mover.path(frame);
    pushBoxPoints(pts, rgbBytes, MOVER_RGB[mi % MOVER_RGB.length], p.x, p.z, p.yaw, mover.size, frame * 13 + mi * 977);
  });
  const count = pts.length / 3;
  const positions = Float32Array.from(pts);
  const rgb = Uint8Array.from(rgbBytes);
  return { positions, intensity: null, rgb, count };
}

function encodeBinaryPcd(frame: PointCloudFrame): ArrayBuffer {
  const header = `# .PCD v0.7 - Labelfaster demo (xyzrgb)
VERSION 0.7
FIELDS x y z rgb
SIZE 4 4 4 4
TYPE F F F F
COUNT 1 1 1 1
WIDTH ${frame.count}
HEIGHT 1
VIEWPOINT 0 0 0 1 0 0 0
POINTS ${frame.count}
DATA binary
`;
  const headerBytes = new TextEncoder().encode(header);
  const body = new Uint8Array(frame.count * 16);
  const f32 = new DataView(body.buffer);
  const u32 = new DataView(body.buffer);
  for (let i = 0; i < frame.count; i++) {
    f32.setFloat32(i * 16, frame.positions[i * 3], true);
    f32.setFloat32(i * 16 + 4, frame.positions[i * 3 + 1], true);
    f32.setFloat32(i * 16 + 8, frame.positions[i * 3 + 2], true);
    // PCL convention: rgb travels in a float32 slot whose bit pattern is 0x00RRGGBB
    const packed = (frame.rgb![i * 3] << 16) | (frame.rgb![i * 3 + 1] << 8) | frame.rgb![i * 3 + 2];
    u32.setUint32(i * 16 + 12, packed, true);
  }
  const out = new Uint8Array(headerBytes.length + body.length);
  out.set(headerBytes, 0);
  out.set(body, headerBytes.length);
  return out.buffer;
}

const frameCache = new Map<number, PointCloudFrame>();

export const demoNet: NetClient = {
  async fetchJson(url) {
    if (url.startsWith('demo://')) return demoEgoPoses();
    return fetch(url).then((r) => r.json());
  },
  async fetchBinary(url) {
    if (url.startsWith('demo://pointcloud/')) {
      const frame = parseInt(url.split('/').pop() ?? '0', 10) || 0;
      let frameData = frameCache.get(frame);
      if (!frameData) {
        frameData = synthFrame(frame);
        if (frameCache.size > 400) frameCache.clear();
        frameCache.set(frame, frameData);
      }
      return encodeBinaryPcd(frameData);
    }
    return fetch(url).then((r) => r.arrayBuffer());
  },
};

export async function demoFetchImage(url: string): Promise<ImageBitmap> {
  if (!url.startsWith('demo://camera/')) {
    const response = await fetch(url);
    return createImageBitmap(await response.blob(), { imageOrientation: 'flipY' });
  }
  const frame = parseInt(url.split('/').pop() ?? '0', 10) || 0;
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext('2d')!;
  const sky = ctx.createLinearGradient(0, 0, 0, 540);
  sky.addColorStop(0, '#20304a');
  sky.addColorStop(0.55, '#3a4a63');
  sky.addColorStop(0.55, '#2a2d33');
  sky.addColorStop(1, '#1c1e22');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 960, 540);
  // road perspective
  ctx.fillStyle = '#33363c';
  ctx.beginPath();
  ctx.moveTo(420, 297);
  ctx.lineTo(540, 297);
  ctx.lineTo(860, 540);
  ctx.lineTo(100, 540);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#e8e8e8';
  for (let i = 0; i < 5; i++) {
    const t = i / 5;
    const y = 300 + t * t * 240;
    ctx.globalAlpha = 0.7 - t * 0.4;
    ctx.beginPath();
    ctx.moveTo(480 - (1 - t) * 8, y);
    ctx.lineTo(480 + (1 - t) * 8, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#8fb4ff';
  ctx.font = '600 24px system-ui';
  ctx.fillText(`DEMO cam · frame ${frame}`, 20, 40);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'));
  return createImageBitmap(blob, { imageOrientation: 'flipY' });
}

// ---- pre-seeded annotations ----

export function demoSeedSnapshot(sequenceId: string) {
  const track = (
    id: string,
    label: string,
    frames: number[],
    poses: Array<[number, number, number]>,
    yaws: number[],
    size: [number, number, number],
    attributes: Record<string, string | number | boolean> = {}
  ) => ({
    meta: {
      id,
      label,
      startFrame: frames[0],
      endFrame: frames[frames.length - 1],
      interpolation: 'linear' as const,
      source: 'human' as const,
      attributes,
    },
    keyframes: {
      frames,
      pos: poses.flat(),
      yaw: yaws,
      size: frames.flatMap(() => size as unknown as number[]).slice(0, frames.length * 3),
    },
  });
  const carKeyframes = Array.from({ length: 6 }, (_, i) => i * 50);
  const carPoses = carKeyframes.map((f) => {
    const p = movers[0].path(f);
    return [p.x, 0.8, p.z] as [number, number, number];
  });
  const pedKeyframes = Array.from({ length: 5 }, (_, i) => i * 60);
  const pedPoses = pedKeyframes.map((f) => {
    const p = movers[1].path(f);
    return [p.x, 0.9, p.z] as [number, number, number];
  });
  return {
    formatVersion: 1 as const,
    sequenceId,
    frameCount: DEMO_FRAME_COUNT,
    createdAt: new Date().toISOString(),
    tracks: [
      track('trk_000001', 'Car', carKeyframes, carPoses, carKeyframes.map((f) => movers[0].path(f).yaw), [4.5, 1.6, 2.0], { color: 'red' }),
      track('trk_000002', 'Pedestrian', pedKeyframes, pedPoses, pedKeyframes.map((f) => movers[1].path(f).yaw), [0.7, 1.75, 0.7]),
      track('trk_000003', 'Car', [0, 299], [[-14, 0.8, -10], [-14, 0.8, -8]], [0.3, 0.3], [4.5, 1.6, 2.0], { color: 'white' }),
    ],
    geometries: [
      {
        meta: { id: 'geo_000001', kind: 'lane' as const, label: 'Lane', closed: false, startFrame: 0, endFrame: DEMO_FRAME_COUNT - 1, attributes: {} },
        vertices: [20, 0, -18, 20, 0, 0, 20, 0, 18, 20, 0, 36],
      },
      {
        meta: { id: 'geo_000002', kind: 'crosswalk' as const, label: 'Crosswalk', closed: true, startFrame: 0, endFrame: DEMO_FRAME_COUNT - 1, attributes: {} },
        vertices: [-4, 0, 14, 4, 0, 14, 4, 0, 20, -4, 0, 20],
      },
    ],
  };
}

/** Mock pre-annotation adapter: noisy copies of demo ground truth. */
export class DemoAssistAdapter implements AssistAdapter {
  readonly name = 'demo-detector-v3';
  private frameCount: number;

  constructor(frameCount: number) {
    this.frameCount = frameCount;
  }

  async generate(): Promise<AssistCandidate[]> {
    const candidates: AssistCandidate[] = [];
    movers.forEach((mover, mi) => {
      const keyframes: AssistCandidate['keyframes'] = [];
      for (let f = 0; f < this.frameCount; f += 30) {
        const p = mover.path(f);
        keyframes.push({
          frame: f,
          pos: [p.x + (rand1(f, mi) - 0.5) * 0.6, mover.size[1] / 2, p.z + (rand1(f + 7, mi) - 0.5) * 0.6],
          yaw: p.yaw + (rand1(f + 3, mi) - 0.5) * 0.1,
          size: [mover.size[0], mover.size[1], mover.size[2]],
        });
      }
      candidates.push({
        label: mover.label,
        confidence: 0.95 - mi * 0.3,
        startFrame: 0,
        endFrame: this.frameCount - 1,
        keyframes,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 350)); // simulate inference
    return candidates;
  }
}

function rand1(seed: number, salt: number): number {
  let s = (seed * 7919 + salt * 104729) & 0x7fffffff;
  s = (s * 1103515245 + 12345) & 0x7fffffff;
  return s / 0x7fffffff;
}

export { parsePcd };

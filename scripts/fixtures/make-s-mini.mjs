#!/usr/bin/env node
/**
 * Generates the S-mini synthetic fixture (contract: delivery-contracts §1).
 * Z-up world, timeUs reference axis, deterministic PRNG, 31 frames @10Hz.
 *
 * Independent ground truth (NOT computed by product code):
 *   - keyframes: frame 10 center (0,0,1), frame 20 center (10,0,1),
 *     size (4,2,2), yaw 0 (J01-2 scenario from ai-acceptance-protocol §4)
 *   - linear interpolation => frame 12 (2,0,1), 15 (5,0,1), 18 (8,0,1)
 *   - after J01-3 edit (frame15 -> (5,2,1)): 12 (2,0.8,1), 18 (8,0.8,1)
 *   - projection control points via hand-written pinhole math below
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] ?? 'fixtures/s-mini';
const FRAMES = 31;
const FPS = 10;
const timeUs = (f) => f * 100000;

// deterministic PRNG (LCG) — same points on every run
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const boxAt = (f) => {
  if (f < 10 || f > 20) return null;
  const t = (f - 10) / 10;
  return { x: 10 * t, y: 0, z: 1, yaw: 0, size: [4, 2, 2] };
};

function writeBmp(path, w, h, rgba) {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + stride * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const s = ((h - 1 - row) * w + col) * 4;
      const d = 54 + row * stride + col * 3;
      buf[d] = rgba[s + 2]; buf[d + 1] = rgba[s + 1]; buf[d + 2] = rgba[s];
    }
  }
  writeFileSync(path, buf);
}

function writeBinaryPcd(path, positions, intensity, count) {
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
  const hb = new TextEncoder().encode(header);
  const body = new Uint8Array(count * 16);
  const view = new DataView(body.buffer);
  for (let i = 0; i < count; i++) {
    view.setFloat32(i * 16, positions[i * 3], true);
    view.setFloat32(i * 16 + 4, positions[i * 3 + 1], true);
    view.setFloat32(i * 16 + 8, positions[i * 3 + 2], true);
    view.setFloat32(i * 16 + 12, intensity[i], true);
  }
  const out = new Uint8Array(hb.length + body.length);
  out.set(hb, 0); out.set(body, hb.length);
  writeFileSync(path, out);
}

// ---- independent pinhole projection (hand math, no product imports) ----
// T_ego_from_sensor: sensor X -> ego -Y, sensor Y -> ego -Z, sensor Z -> ego +X,
// origin (0,0,1.2). p_cam = R * (p_ego - origin), R rows = sensor axes in ego.
const camOrigin = [0, 0, 1.2];
const camR = [
  [0, -1, 0],
  [0, 0, -1],
  [1, 0, 0],
];
const fx = 400, fy = 400, cx = 320, cy = 240;
function project(pEgo) {
  const d = [pEgo[0] - camOrigin[0], pEgo[1] - camOrigin[1], pEgo[2] - camOrigin[2]];
  const pc = [
    camR[0][0] * d[0] + camR[0][1] * d[1] + camR[0][2] * d[2],
    camR[1][0] * d[0] + camR[1][1] * d[1] + camR[1][2] * d[2],
    camR[2][0] * d[0] + camR[2][1] * d[1] + camR[2][2] * d[2],
  ];
  if (pc[2] <= 0.01) return null;
  return { x: fx * (pc[0] / pc[2]) + cx, y: fy * (pc[1] / pc[2]) + cy, depth: pc[2] };
}

// box corners (center, yaw=0, size 4x2x2 => l=4 along x, w=2 along y, h=2)
function corners(center, l, w, h) {
  const out = [];
  for (const dz of [-1, 1]) for (const dy of [-1, 1]) for (const dx of [-1, 1]) {
    out.push([center[0] + (dx * l) / 2, center[1] + (dy * w) / 2, center[2] + (dz * h) / 2]);
  }
  return out;
}

// ---- generate ----
mkdirSync(join(ROOT, 'pcd'), { recursive: true });
mkdirSync(join(ROOT, 'images'), { recursive: true });
mkdirSync(join(ROOT, 'bev', '0', '0'), { recursive: true });
mkdirSync(join(ROOT, 'heights', '0', '0'), { recursive: true });

const BEV_ORIGIN = [-12.8, -12.8];
const BEV_MPP = 0.05;
const BEV_SIZE = 512;
const ground = Buffer.alloc(BEV_SIZE * BEV_SIZE * 4, 0);
const heightPx = Buffer.alloc(BEV_SIZE * BEV_SIZE * 4, 0);

const checksums = {};
const addChecksum = (rel, buf) => {
  checksums[rel.split('\\').join('/')] = createHash('sha256').update(buf).digest('hex');
  return buf;
};

const controlPoints = [];
for (let f = 0; f < FRAMES; f++) {
  seed = 1000 + f * 7;
  const pts = [];
  // ground grid: 40m x 40m
  for (let i = 0; i < 3000; i++) {
    pts.push([(rand() - 0.5) * 40, (rand() - 0.5) * 40, 0]);
  }
  const box = boxAt(f);
  if (box) {
    for (let i = 0; i < 400; i++) {
      pts.push([
        box.x + (rand() - 0.5) * box.size[0],
        box.y + (rand() - 0.5) * box.size[1],
        rand() * box.size[2],
      ]);
    }
  }
  const count = pts.length;
  const positions = new Float32Array(count * 3);
  const intensity = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions.set(pts[i], i * 3);
    intensity[i] = 0.5;
    // rasterize into BEV ground (z=0 hits only)
    if (pts[i][2] === 0) {
      const px = Math.round((pts[i][0] - BEV_ORIGIN[0]) / BEV_MPP);
      const py = Math.round((pts[i][1] - BEV_ORIGIN[1]) / BEV_MPP);
      if (px >= 0 && py >= 0 && px < BEV_SIZE && py < BEV_SIZE) {
        const idx = (py * BEV_SIZE + px) * 4;
        ground[idx] = 150; ground[idx + 1] = 150; ground[idx + 2] = 160; ground[idx + 3] = 255;
        // ground height = 0 => fixed point (0 + 1000) * 100 = 100000 = 0x0186A0
        heightPx[idx] = 0xA0; heightPx[idx + 1] = 0x86; heightPx[idx + 2] = 0x01; heightPx[idx + 3] = 255;
      }
    }
  }
  const rel = `pcd/${f}.pcd`;
  const pcdBuf = (() => {
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
    const hb = new TextEncoder().encode(header);
    const body = new Uint8Array(count * 16);
    const view = new DataView(body.buffer);
    for (let i = 0; i < count; i++) {
      view.setFloat32(i * 16, positions[i * 3], true);
      view.setFloat32(i * 16 + 4, positions[i * 3 + 1], true);
      view.setFloat32(i * 16 + 8, positions[i * 3 + 2], true);
      view.setFloat32(i * 16 + 12, intensity[i], true);
    }
    const out = new Uint8Array(hb.length + body.length);
    out.set(hb, 0); out.set(body, hb.length);
    return out;
  })();
  writeFileSync(join(ROOT, rel), addChecksum(rel, pcdBuf));

  // camera image: independent projected wireframe of the box
  const img = Buffer.alloc(640 * 480 * 4, 0);
  for (let i = 0; i < 640 * 480; i++) { img[i * 4 + 3] = 255; }
  if (box) {
    const cs = corners([box.x, box.y, box.z], box.size[0], box.size[1], box.size[2]);
    const edges = [[0,1],[1,3],[3,2],[2,0],[4,5],[5,7],[7,6],[6,4],[0,4],[1,5],[2,6],[3,7]];
    for (const [a, b] of edges) {
      const pa = project(cs[a]); const pb = project(cs[b]);
      if (!pa || !pb) continue;
      const steps = Math.ceil(Math.hypot(pb.x - pa.x, pb.y - pa.y));
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(pa.x + ((pb.x - pa.x) * s) / steps);
        const y = Math.round(pa.y + ((pb.y - pa.y) * s) / steps);
        if (x >= 0 && y >= 0 && x < 640 && y < 480) {
          const idx = (y * 640 + x) * 4;
          img[idx] = 0x3d; img[idx + 1] = 0xdc; img[idx + 2] = 0x97; img[idx + 3] = 255;
        }
      }
    }
    if (f === 20) {
      for (const c of cs) {
        const p = project(c);
        if (p) controlPoints.push({ world: c, pixel: { x: +p.x.toFixed(2), y: +p.y.toFixed(2) } });
      }
    }
  }
  const imgRel = `images/${f}.bmp`;
  const imgBuf = (() => {
    const w = 640, h = 480;
    const stride = Math.ceil((w * 3) / 4) * 4;
    const buf = Buffer.alloc(54 + stride * h);
    buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
    buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
    buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const s = ((h - 1 - row) * w + col) * 4;
        const d = 54 + row * stride + col * 3;
        buf[d] = img[s + 2]; buf[d + 1] = img[s + 1]; buf[d + 2] = img[s];
      }
    }
    return buf;
  })();
  writeFileSync(join(ROOT, imgRel), addChecksum(imgRel, imgBuf));
}

// BEV + height single tiles
const bevRel = 'bev/0/0/0.bmp';
writeFileSync(join(ROOT, bevRel), addChecksum(bevRel, (() => {
  const w = BEV_SIZE, h = BEV_SIZE;
  const stride = w * 3;
  const buf = Buffer.alloc(54 + stride * h);
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const s = ((h - 1 - row) * w + col) * 4;
      const d = 54 + row * stride + col * 3;
      buf[d] = ground[s + 2]; buf[d + 1] = ground[s + 1]; buf[d + 2] = ground[s];
    }
  }
  return buf;
})()));
const hRel = 'heights/0/0/0.bmp';
writeFileSync(join(ROOT, hRel), addChecksum(hRel, (() => {
  const w = BEV_SIZE, h = BEV_SIZE;
  const stride = w * 3;
  const buf = Buffer.alloc(54 + stride * h);
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const s = ((h - 1 - row) * w + col) * 4;
      const d = 54 + row * stride + col * 3;
      buf[d] = heightPx[s + 2]; buf[d + 1] = heightPx[s + 1]; buf[d + 2] = heightPx[s];
    }
  }
  return buf;
})()));

// manifest v2 (Z-up, timeUs, identity ego pose, contract fields)
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = {
  formatVersion: 2,
  datasetId: 's-mini',
  datasetVersion: '1.0.0',
  contentHash: '',
  worldConvention: { up: 'z', units: 'meter', angleUnit: 'radian', originNote: 'ego frame 0' },
  referenceFrames: Array.from({ length: FRAMES }, (_, f) => ({ frameId: f, timeUs: timeUs(f) })),
  pose: {
    source: 'synthetic-static',
    interpolation: 'none-samples-complete',
    maxGapUs: 100000,
    frames: Array.from({ length: FRAMES }, (_, f) => ({ frameId: f, timeUs: timeUs(f), T_world_from_ego: identity })),
  },
  sensors: [
    { sensorId: 'lidar', type: 'lidar', model: 'none', distortionState: 'raw', T_ego_from_sensor: identity,
      timeSync: { toleranceUs: 1000, fallback: 'none' }, pcdTemplate: 'pcd/{frame}.pcd',
      pointCloud: { fields: ['x', 'y', 'z', 'intensity'], encoding: 'binary-pcd', bytesPerPoint: 16, motionDistorted: false, referenceTime: 'mid' } },
    { sensorId: 'cam', type: 'camera', model: 'pinhole', distortionState: 'undistorted', distortion: [],
      intrinsics: { fx, fy, cx, cy }, width: 640, height: 480,
      T_ego_from_sensor: [0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1.2, 1],
      timeSync: { toleranceUs: 1000, fallback: 'none' }, imageTemplate: 'images/{frame}.bmp' },
  ],
  bev: {
    tileset: { originX: BEV_ORIGIN[0], originY: BEV_ORIGIN[1], metersPerPixel: BEV_MPP, width: BEV_SIZE, height: BEV_SIZE, tileSize: BEV_SIZE, urlTemplate: 'bev/0/0/0.bmp', pixelCenter: 'top-left-center', axisNote: 'image +x -> world +x, image +y -> world +y' },
    height: { encoding: 'rgb24-fixed-point', scale: 0.01, offset: -1000, verticalDatum: 'same-as-world', noData: null, samplePrecisionM: 0.01, tileset: { originX: BEV_ORIGIN[0], originY: BEV_ORIGIN[1], metersPerPixel: BEV_MPP, width: BEV_SIZE, height: BEV_SIZE, tileSize: BEV_SIZE, urlTemplate: 'heights/0/0/0.bmp' } },
  },
  resources: Object.entries(checksums).map(([rel, sha]) => ({ resourceId: rel, uri: rel, sha256: sha })),
};
const canon = JSON.stringify(manifest, Object.keys(manifest).sort());
manifest.contentHash = 'sha256:' + createHash('sha256').update(canon).digest('hex');
writeFileSync(join(ROOT, 'manifest.json'), addChecksum('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2))));

// independent expected answers (NOT derived from product code)
const expected = {
  note: 'Hand-computed ground truth. J01-3 edit means: frame15 keyframe set to (5,2,1).',
  trajectory: {
    label: 'Car',
    keyframes: [
      { frame: 10, center: [0, 0, 1], yaw: 0, size: [4, 2, 2] },
      { frame: 20, center: [10, 0, 1], yaw: 0, size: [4, 2, 2] },
    ],
    existenceHalfOpen: [10, 21],
    interpolationBeforeEdit: { 12: [2, 0, 1], 15: [5, 0, 1], 18: [8, 0, 1] },
    interpolationAfterJ01_3Edit: { 12: [2, 0.8, 1], 15: [5, 2, 1], 18: [8, 0.8, 1] },
  },
  projectionControlPointsFrame20: controlPoints,
  tolerance: { pixel: 0.5, positionM: 0.01 },
};
writeFileSync(join(ROOT, 'INDEPENDENT_EXPECTED.json'), addChecksum('INDEPENDENT_EXPECTED.json', Buffer.from(JSON.stringify(expected, null, 2))));

writeFileSync(join(ROOT, 'checksums.json'), JSON.stringify(checksums, null, 2));
console.log(`s-mini generated: ${FRAMES} frames, ${Object.keys(checksums).length} checksummed files, ${controlPoints.length} control points`);

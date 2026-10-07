#!/usr/bin/env node
/**
 * Converts a KITTI tracking sequence (+ its raw drive archive) into
 * Labelfaster native formats:
 *   - binary PCD per frame, points transformed velo → imu → world (ENU),
 *     then axis-mapped to the engine frame (x fwd, y up, z right)
 *   - egoPoses.json (per-frame ego→world 4x4, column-major, 16 floats)
 *   - snapshot.json (tracking labels → tracks with dense keyframes)
 *   - manifest.json (Labelfaster SequenceManifest)
 *
 * Usage: node scripts/convert-kitti-tracking.mjs <workDir> <seq> <rawDriveRoot> <outDir>
 *   workDir      = /tmp/kitti4d  (contains labels/, calib/, extracted raw)
 *   seq          = e.g. 0004
 *   rawDriveRoot = 2011_09_26/2011_09_26_drive_0084_sync (inside workDir)
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [workDir, seq, rawDriveRoot, outDir] = process.argv.slice(2);
if (!workDir || !seq || !rawDriveRoot || !outDir) {
  console.error('usage: convert-kitti-tracking.mjs <workDir> <seq> <rawDriveRoot> <outDir>');
  process.exit(1);
}

// ---------- calib ----------
function parseCalib(path) {
  const text = readFileSync(path, 'utf8');
  const mats = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const values = m[2].trim().split(/\s+/).map(Number);
    mats[m[1]] = values;
  }
  return mats;
}

// row-major R (3x3 block) + T (3) -> column-major 4x4
function mat34(R9, T3) {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[c * 4 + r] = R9[r * 3 + c];
    }
    out[12 + r] = T3[r];
  }
  out[15] = 1;
  return out;
}

function mat4Invert(m) {
  const inv = new Float64Array(16);
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) throw new Error('singular matrix');
  det = 1 / det;
  out(0, (a11 * b11 - a12 * b10 + a13 * b09) * det);
  out(1, (a02 * b10 - a01 * b11 - a03 * b09) * det);
  out(2, (a31 * b05 - a32 * b04 + a33 * b03) * det);
  out(3, (a22 * b04 - a21 * b05 - a23 * b03) * det);
  out(4, (a12 * b08 - a10 * b11 - a13 * b07) * det);
  out(5, (a00 * b11 - a02 * b08 + a03 * b07) * det);
  out(6, (a32 * b02 - a30 * b05 - a33 * b01) * det);
  out(7, (a20 * b05 - a22 * b02 + a23 * b01) * det);
  out(8, (a10 * b10 - a11 * b08 + a13 * b06) * det);
  out(9, (a01 * b08 - a00 * b10 - a03 * b06) * det);
  out(10, (a30 * b04 - a31 * b02 + a33 * b00) * det);
  out(11, (a21 * b02 - a20 * b04 - a23 * b00) * det);
  out(12, (a11 * b07 - a10 * b09 - a12 * b06) * det);
  out(13, (a00 * b09 - a01 * b07 + a02 * b06) * det);
  out(14, (a31 * b01 - a30 * b03 - a32 * b00) * det);
  out(15, (a20 * b03 - a21 * b01 + a22 * b00) * det);
  function out(i, v) { inv[i] = v; }
  return inv;
}

function mat4Mul(a, b) {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function applyMat(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// axis map: ENU/imu-axes (x fwd, y left, z up) -> engine (x fwd, y up, z right)
// 列主序读取：(x,y,z) → (x, z, -y)，ENU 的 +Z（上）映射为引擎的 +Y（上）
const AXIS_MAP = [
  1, 0, 0, 0,
  0, 0, -1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
];
const AXIS_MAP_INV = mat4Invert(AXIS_MAP);

// ---------- oxts -> ENU poses (KITTI devkit Mercator convention) ----------
function oxtsToPoses(files, oxtsDirPath) {
  const er = 6378137; // 地球半径（WGS84 半长轴，KITTI devkit 约定）
  const rows = files.map((f) => readFileSync(join(oxtsDirPath, f), 'utf8').trim().split(/\s+/).map(Number));
  const scale = Math.cos((rows[0][0] * Math.PI) / 180); // 首帧纬度的余弦作为 Mercator 缩放
  const poses = [];
  let x0 = 0, y0 = 0, z0 = 0;
  rows.forEach((r, i) => {
    const [lat, lon, alt, roll, pitch, yaw] = r;
    const latR = (lat * Math.PI) / 180;
    const lonR = (lon * Math.PI) / 180;
    // KITTI devkit: east = er·scale·lon, north = er·scale·log(tan(π/4+lat/2))
    const x = er * scale * lonR;
    const y = er * scale * Math.log(Math.tan(Math.PI / 4 + latR / 2));
    const z = alt;
    if (i === 0) { x0 = x; y0 = y; z0 = z; }
    // OXTS roll/pitch/yaw 已是弧度（dataformat.txt 明确），不得再乘 π/180
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // R = Rz(yaw) * Ry(pitch) * Rx(roll)
    const R = [
      cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
      sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr,
      -sp, cp * sr, cp * cr,
    ];
    const pose = [
      R[0], R[3], R[6], 0,
      R[1], R[4], R[7], 0,
      R[2], R[5], R[8], 0,
      x - x0, y - y0, z - z0, 1,
    ];
    poses.push(pose);
  });
  return poses;
}

// ---------- main ----------
// Raw-date calib (identical to the chain validated by probe-kitti-mapping.mjs):
// labels are in RECTIFIED cam0 coords -> cam0 -> velo -> imu -> world(enu) -> engine axes
const rawCamToCam = parseCalib(join(workDir, 'calib_date/2011_09_26/calib_cam_to_cam.txt'));
const rawVeloToCam = parseCalib(join(workDir, 'calib_date/2011_09_26/calib_velo_to_cam.txt'));
const rawImuToVelo = parseCalib(join(workDir, 'calib_date/2011_09_26/calib_imu_to_velo.txt'));

function mat3ToMat4(r9) {
  return [
    r9[0], r9[3], r9[6], 0,
    r9[1], r9[4], r9[7], 0,
    r9[2], r9[5], r9[8], 0,
    0, 0, 0, 1,
  ];
}
const rectInv = mat3ToMat4([
  // transpose of orthonormal R_rect
  rawCamToCam.R_rect_00[0], rawCamToCam.R_rect_00[3], rawCamToCam.R_rect_00[6],
  rawCamToCam.R_rect_00[1], rawCamToCam.R_rect_00[4], rawCamToCam.R_rect_00[7],
  rawCamToCam.R_rect_00[2], rawCamToCam.R_rect_00[5], rawCamToCam.R_rect_00[8],
]);
const trVeloToCam = mat34(rawVeloToCam.R, rawVeloToCam.T);
const camRectToVelo = mat4Mul(mat4Invert(trVeloToCam), rectInv);
const trImuToVelo = mat34(rawImuToVelo.R, rawImuToVelo.T);
const veloToImuT = mat4Invert(trImuToVelo);

const labelFile = join(workDir, 'labels', 'training', 'label_02', `${seq}.txt`);
const trackFrames = new Map(); // trackId -> Array<{frame, type, truncated, occluded, h,w,l, x,y,z, ry}>
let maxFrame = 0;
for (const line of readFileSync(labelFile, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const p = line.trim().split(/\s+/);
  const frame = parseInt(p[0], 10);
  const trackId = parseInt(p[1], 10);
  const type = p[2];
  if (type === 'DontCare' || type === 'Misc') continue;
  maxFrame = Math.max(maxFrame, frame);
  const entry = {
    frame,
    type,
    truncation: Number(p[3]),
    occlusion: Number(p[4]),
    h: Number(p[10]),
    w: Number(p[11]),
    l: Number(p[12]),
    x: Number(p[13]),
    y: Number(p[14]),
    z: Number(p[15]),
    ry: Number(p[16]),
  };
  if (!trackFrames.has(trackId)) trackFrames.set(trackId, []);
  trackFrames.get(trackId).push(entry);
}
const frameCount = maxFrame + 1;

// ego poses from oxts
const oxtsDir = join(workDir, rawDriveRoot, 'oxts', 'data');
const oxtsFiles = readdirSync(oxtsDir).sort();
const enuPoses = oxtsToPoses(oxtsFiles, oxtsDir);
console.log("debug ego100 t:", enuPoses[100].slice(12,15), "rows:", oxtsFiles.length);
if (enuPoses.length !== frameCount) {
  console.warn(`warning: oxts frames (${enuPoses.length}) != label frames (${frameCount})`);
}
// engine-frame ego->world per frame
const egoPoses = enuPoses.map((pose) => {
  const mapped = mat4Mul(AXIS_MAP, mat4Mul(pose, AXIS_MAP_INV));
  return Array.from(mapped);
});

// global transform chains: velo -> imu -> world(enu) -> engine axes
const veloToEngine = (frame) => mat4Mul(AXIS_MAP, mat4Mul(enuPoses[frame], veloToImuT));
// labels: cam(rect) -> cam0 -> velo -> imu -> world -> engine
const camToEngine = (frame) => mat4Mul(AXIS_MAP, mat4Mul(enuPoses[frame], mat4Mul(veloToImuT, camRectToVelo)));

// pcd output
mkdirSync(join(outDir, 'pcd'), { recursive: true });
const veloDir = join(workDir, rawDriveRoot, 'velodyne_points', 'data');
const bins = readdirSync(veloDir).sort();

function writeBinaryPcd(path, positions, intensity, count) {
  const header = `VERSION 0.7
FIELDS x y z intensity
SIZE 4 4 4 4
TYPE F F F F
COUNT 1 1 1 1
WIDTH ${count}
HEIGHT 1
VIEWPOINT 0 0 0 1 0 0 0
POINTS ${count}
DATA binary
`;
  const headerBytes = new TextEncoder().encode(header);
  const body = new Uint8Array(count * 16);
  const view = new DataView(body.buffer);
  for (let i = 0; i < count; i++) {
    view.setFloat32(i * 16, positions[i * 3], true);
    view.setFloat32(i * 16 + 4, positions[i * 3 + 1], true);
    view.setFloat32(i * 16 + 8, positions[i * 3 + 2], true);
    view.setFloat32(i * 16 + 12, intensity[i], true);
  }
  const out = new Uint8Array(headerBytes.length + body.length);
  out.set(headerBytes, 0);
  out.set(body, headerBytes.length);
  writeFileSync(path, out);
}

let written = 0;
const POINT_STRIDE = Number(process.env.KITTI_POINT_STRIDE ?? 1);
for (let frame = 0; frame < Math.min(bins.length, frameCount); frame++) {
  const bin = readFileSync(join(veloDir, bins[frame]));
  const floatView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const count = Math.floor(bin.byteLength / 16);
  const outCount = Math.ceil(count / POINT_STRIDE);
  const positions = new Float32Array(outCount * 3);
  const intensity = new Float32Array(outCount);
  const transform = veloToEngine(frame);
  let w = 0;
  for (let i = 0; i < count; i += POINT_STRIDE) {
    const x = floatView.getFloat32(i * 16, true);
    const y = floatView.getFloat32(i * 16 + 4, true);
    const z = floatView.getFloat32(i * 16 + 8, true);
    const [gx, gy, gz] = applyMat(transform, x, y, z);
    positions[w * 3] = gx;
    positions[w * 3 + 1] = gy;
    positions[w * 3 + 2] = gz;
    intensity[w] = floatView.getFloat32(i * 16 + 12, true);
    w++;
  }
  writeBinaryPcd(join(outDir, 'pcd', `${frame}.pcd`), positions, intensity, w);
  written++;
}
console.log(`pcd frames written: ${written}`);

// snapshot: tracking labels -> tracks (dense keyframes, the real annotation layout)
const LABEL_MAP = { Car: 'Car', Van: 'Truck', Truck: 'Truck', Pedestrian: 'Pedestrian', 'Person_sitting': 'Pedestrian', 'Person_sitting-ish': 'Pedestrian', Cyclist: 'Cyclist', Tram: 'Truck' };
const tracks = [];
let idCounter = 0;
for (const [, entries] of [...trackFrames.entries()].sort((a, b) => a[0] - b[0])) {
  const label = LABEL_MAP[entries[0].type];
  if (!label) continue;
  idCounter++;
  const id = `kitti_${String(idCounter).padStart(5, '0')}`;
  const frames = [];
  const pos = [];
  const yaw = [];
  const size = [];
  const frameAttributes = [];
  for (const e of entries) {
    const transform = camToEngine(e.frame);
    // KITTI location y is the BOTTOM face center (cam y points down)
    const centerCam = [e.x, e.y - e.h / 2, e.z];
    const [cx, cy, cz] = applyMat(transform, ...centerCam);
    // KITTI length axis: camera X rotated around camera Y
    const dirCam = [Math.cos(e.ry), 0, -Math.sin(e.ry)];
    const d0 = transform[0] * dirCam[0] + transform[4] * dirCam[1] + transform[8] * dirCam[2];
    const d1 = transform[1] * dirCam[0] + transform[5] * dirCam[1] + transform[9] * dirCam[2];
    const d2 = transform[2] * dirCam[0] + transform[6] * dirCam[1] + transform[10] * dirCam[2];
    frames.push(e.frame);
    pos.push(cx, cy, cz);
    yaw.push(Math.atan2(-d2, d0));
    size.push(e.l, e.h, e.w);
    frameAttributes.push({ frame: e.frame, attrs: { occlusion: String(e.occlusion), truncation: String(e.truncation) } });
  }
  tracks.push({
    meta: {
      id,
      label,
      startFrame: frames[0],
      endFrame: frames[frames.length - 1],
      interpolation: 'linear',
      source: 'human',
      attributes: { kitti_type: entries[0].type },
    },
    keyframes: { frames, pos, yaw, size },
    frameAttributes,
  });
}

const snapshot = {
  formatVersion: 1,
  sequenceId: `kitti_tracking_${seq}`,
  frameCount,
  createdAt: new Date().toISOString(),
  qa: { status: 'pending', notes: `KITTI tracking ${seq} official labels` },
  tracks,
  geometries: [],
};
writeFileSync(join(outDir, 'snapshot.json'), JSON.stringify(snapshot));
const manifest = {
  formatVersion: 1,
  id: `kitti_tracking_${seq}`,
  fps: 10,
  frameCount,
  egoPoses: egoPoses,
  pointCloud: { urlTemplate: 'kitti/pcd/{frame}.pcd', format: 'pcd', approxBytesPerFrame: 1_900_000 },
  qa: { status: 'pending', notes: 'KITTI tracking official labels' },
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest));
console.log(`tracks: ${tracks.length}, keyframes: ${tracks.reduce((s, t) => s + t.keyframes.frames.length, 0)}, frames: ${frameCount}`);
console.log('done ->', outDir);

#!/usr/bin/env node
/**
 * Assembles the R-mini real fixture from the local KITTI raw archive.
 * Source (documented, outside repo): /tmp/kitti4d/raw_drive.zip
 *   (2011_09_26_drive_0084_sync + calib_date + tracking labels for seq 0011)
 * Output: fixtures/r-mini — Z-up world (ENU, ego=imu), timeUs axis, 200 frames
 * (20s), camera image_02 + lidar + pose + BEV tiles generated from the same
 * point cloud (registration by construction, see DECISIONS D-08) +
 * reference-answers.json from official KITTI tracking labels.
 * Exit 2 (BLOCKED) when source archive is missing.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const SRC = '/tmp/kitti4d';
const ZIP = join(SRC, 'raw_drive.zip');
const OUT = process.argv[2] ?? 'fixtures/r-mini';
const FRAMES = 200;
const FPS = 10;

if (!existsSync(ZIP)) {
  console.error('BLOCKED: source archive missing:', ZIP);
  console.error('Obtain 2011_09_26_drive_0084_sync.zip (KITTI raw) and place it there, or update SRC.');
  process.exit(2);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const mat34 = (R9, T3) => {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[c * 4 + r] = R9[r * 3 + c];
    out[12 + r] = T3[r];
  }
  out[15] = 1;
  return out;
};
const inv = (m) => {
  const g = (i) => m[i];
  const a00 = g(0), a01 = g(1), a02 = g(2), a03 = g(3), a10 = g(4), a11 = g(5), a12 = g(6), a13 = g(7),
    a20 = g(8), a21 = g(9), a22 = g(10), a23 = g(11), a30 = g(12), a31 = g(13), a32 = g(14), a33 = g(15);
  const b00 = a00*a11-a01*a10, b01 = a00*a12-a02*a10, b02 = a00*a13-a03*a10, b03 = a01*a12-a02*a11,
    b04 = a01*a13-a03*a11, b05 = a02*a13-a03*a12, b06 = a20*a31-a21*a30, b07 = a20*a32-a22*a30,
    b08 = a20*a33-a23*a30, b09 = a21*a32-a22*a31, b10 = a21*a33-a23*a31, b11 = a22*a33-a23*a32;
  let det = b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06; det = 1/det;
  return [(a11*b11-a12*b10+a13*b09)*det,(a02*b10-a01*b11-a03*b09)*det,(a31*b05-a32*b04+a33*b03)*det,(a22*b04-a21*b05-a23*b03)*det,
    (a12*b08-a10*b11-a13*b07)*det,(a00*b11-a02*b08+a03*b07)*det,(a32*b02-a30*b05-a33*b01)*det,(a20*b05-a22*b02+a23*b01)*det,
    (a10*b10-a11*b08+a13*b06)*det,(a01*b08-a00*b10-a03*b06)*det,(a30*b04-a31*b02+a33*b00)*det,(a21*b02-a20*b04-a23*b00)*det,
    (a11*b07-a10*b09-a12*b06)*det,(a00*b09-a01*b07+a02*b06)*det,(a31*b01-a30*b03-a32*b00)*det,(a20*b03-a21*b01+a22*b00)*det];
};
const mul = (a, b) => {
  const o = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
  }
  return o;
};
const apply = (m, x, y, z) => [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]];
const parseCalib = (p) => {
  const mats = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) mats[m[1]] = m[2].trim().split(/\s+/).map(Number);
  }
  return mats;
};

// extract needed paths (idempotent)
if (!existsSync(join(SRC, '2011_09_26/2011_09_26_drive_0084_sync/velodyne_points'))) {
  execSync(`unzip -q -o ${ZIP} "2011_09_26/2011_09_26_drive_0084_sync/velodyne_points/*" "2011_09_26/2011_09_26_drive_0084_sync/oxts/*" "2011_09_26/2011_09_26_drive_0084_sync/image_02/*"`, { cwd: SRC, stdio: 'inherit' });
}
if (!existsSync(join(SRC, 'calib_date'))) {
  execSync(`curl -s -o calib_date.zip https://s3.eu-central-1.amazonaws.com/avg-kitti/raw_data/2011_09_26_calib.zip && unzip -q -o calib_date.zip -d calib_date`, { cwd: SRC, stdio: 'inherit' });
}
if (!existsSync(join(SRC, 'labels'))) {
  execSync(`curl -s -o labels.zip https://s3.eu-central-1.amazonaws.com/avg-kitti/data_tracking_label_2.zip && unzip -q -o labels.zip -d labels`, { cwd: SRC, stdio: 'inherit' });
}

const drive = '2011_09_26/2011_09_26_drive_0084_sync';
const calib = parseCalib(join(SRC, 'calib_date/2011_09_26/calib_cam_to_cam.txt'));
const vc = parseCalib(join(SRC, 'calib_date/2011_09_26/calib_velo_to_cam.txt'));
const iv = parseCalib(join(SRC, 'calib_date/2011_09_26/calib_imu_to_velo.txt'));
const trVeloToCam = mat34(vc.R, vc.T);
const rectInv = mat34([
  calib.R_rect_00[0], calib.R_rect_00[3], calib.R_rect_00[6],
  calib.R_rect_00[1], calib.R_rect_00[4], calib.R_rect_00[7],
  calib.R_rect_00[2], calib.R_rect_00[5], calib.R_rect_00[8],
], [0, 0, 0]);
const camRectToVelo = mul(inv(trVeloToCam), rectInv);
const veloToImu = inv(mat34(iv.R, iv.T));

// oxts -> ENU poses (Z-up world, ego = imu)
const oxtsDir = join(SRC, drive, 'oxts/data');
const files = readdirSync(oxtsDir).sort().slice(0, FRAMES);
const er = 6378137, ep = 6356752.3142, ecc = Math.sqrt(er*er - ep*ep) / er;
const rows = files.map((f) => readFileSync(join(oxtsDir, f), 'utf8').trim().split(/\s+/).map(Number));
const scale = Math.cos((rows[0][0] * Math.PI) / 180);
let x0 = 0, y0 = 0, z0 = 0;
const poses = rows.map((r, i) => {
  const [lat, lon, alt, roll, pitch, yaw] = r;
  const latR = (lat * Math.PI) / 180, lonR = (lon * Math.PI) / 180;
  const rm = er / Math.sqrt(1 - ecc * ecc * Math.sin(latR) ** 2);
  const x = rm * scale * lonR, y = rm * Math.log(Math.tan(Math.PI / 4 + latR / 2)), z = alt;
  if (i === 0) { x0 = x; y0 = y; z0 = z; }
  const d2r = Math.PI / 180;
  const cr = Math.cos(roll*d2r), sr = Math.sin(roll*d2r), cp = Math.cos(pitch*d2r), sp = Math.sin(pitch*d2r), cy = Math.cos(yaw*d2r), sy = Math.sin(yaw*d2r);
  const R = [cy*cp, cy*sp*sr - sy*cr, cy*sp*cr + sy*sr, sy*cp, sy*sp*sr + cy*cr, sy*sp*cr - cy*sr, -sp, cp*sr, cp*cr];
  const pose = new Array(16).fill(0);
  for (let rr = 0; rr < 3; rr++) for (let cc = 0; cc < 3; cc++) pose[cc*4+rr] = R[rr*3+cc];
  pose[12] = x - x0; pose[13] = y - y0; pose[14] = z - z0; pose[15] = 1;
  return pose;
});
const veloToWorld = (f) => mul(poses[f], veloToImu);

// P2 intrinsics + cam2 rectified chain: x_img2 = P2 · R_rect_02 · x_velo (velo = velodyne frame)
const tcal = parseCalib(join(SRC, 'calib/training/calib/0011.txt'));
const P2 = tcal.P2;
const R_rect_02 = calib.R_rect_02;
const cam2RectFromVelo = mul(mat34(R_rect_02, [0, 0, 0]), mat34(vc.R, vc.T));
const T_ego_from_cam2 = mul(veloToImu, inv(cam2RectFromVelo));
mkdirSync(join(OUT, 'pcd'), { recursive: true });
mkdirSync(join(OUT, 'images'), { recursive: true });

const checksums = {};
const put = (rel, buf) => { writeFileSync(join(OUT, rel), buf); checksums[rel] = sha(buf); };

const veloDir = join(SRC, drive, 'velodyne_points/data');
const bins = readdirSync(veloDir).filter((f) => f.endsWith('.bin')).sort();
const imgDir = join(SRC, drive, 'image_02/data');
const imgs = readdirSync(imgDir).filter((f) => f.endsWith('.png')).sort();

for (let f = 0; f < FRAMES; f++) {
  const bin = readFileSync(join(veloDir, bins[f]));
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const count = Math.floor(bin.byteLength / 16);
  const positions = new Float32Array(count * 3);
  const inten = new Float32Array(count);
  const T = veloToWorld(f);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = apply(T, view.getFloat32(i*16, true), view.getFloat32(i*16+4, true), view.getFloat32(i*16+8, true));
    positions[i*3] = x; positions[i*3+1] = y; positions[i*3+2] = z;
    inten[i] = view.getFloat32(i*16+12, true);
  }
  const header = `VERSION 0.7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH ${count}\nHEIGHT 1\nPOINTS ${count}\nDATA binary\n`;
  const hb = new TextEncoder().encode(header);
  const body = new Uint8Array(count * 16);
  const bv = new DataView(body.buffer);
  for (let i = 0; i < count; i++) {
    bv.setFloat32(i*16, positions[i*3], true);
    bv.setFloat32(i*16+4, positions[i*3+1], true);
    bv.setFloat32(i*16+8, positions[i*3+2], true);
    bv.setFloat32(i*16+12, inten[i], true);
  }
  const out = new Uint8Array(hb.length + body.length);
  out.set(hb, 0); out.set(body, hb.length);
  put(`pcd/${f}.pcd`, Buffer.from(out));
  put(`images/${f}.png`, readFileSync(join(imgDir, imgs[f])));
}

// reference answers: official KITTI labels -> Z-up world boxes (frame-matched)
const camRectToImu = mul(veloToImu, camRectToVelo);
const referenceTracks = new Map();
for (const line of readFileSync(join(SRC, 'labels/training/label_02/0011.txt'), 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const p = line.split(/\s+/);
  const frame = parseInt(p[0], 10);
  if (frame >= FRAMES || ['DontCare', 'Misc'].includes(p[2])) continue;
  const h = +p[10], x = +p[13], y = +p[14] - h / 2, z = +p[15], ry = +p[16];
  const center = apply(camRectToImu, x, y, z);
  const d = [Math.sin(ry), 0, Math.cos(ry)];
  const dir = apply(camRectToImu, d[0], d[1], d[2]);
  const id = `kitti_${p[1].padStart(5, '0')}`;
  if (!referenceTracks.has(id)) referenceTracks.set(id, { id, label: p[2], frames: [] });
  referenceTracks.get(id).frames.push({
    frame, center: center.map((v) => +v.toFixed(4)),
    yaw: Math.atan2(-dir[1], dir[0]), size: [+p[12], +p[10], +p[11]],
    occlusion: p[4],
  });
}

// BEV tiles from the same points (registration by construction)
const BEV = { originX: -60, originY: -60, mpp: 0.25, size: 512 };
mkdirSync(join(OUT, 'bev', '0', '0'), { recursive: true });
const raster = Buffer.alloc(BEV.size * BEV.size * 4);
for (let f = 0; f < FRAMES; f += 5) {
  const buf = readFileSync(join(OUT, `pcd/${f}.pcd`));
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerEnd = buf.indexOf(Buffer.from('DATA binary\n')) + 12;
  const n = Math.floor((buf.byteLength - headerEnd) / 16);
  for (let i = 0; i < n; i++) {
    const x = v.getFloat32(headerEnd + i*16, true);
    const y = v.getFloat32(headerEnd + i*16+4, true);
    const px = Math.round((x - BEV.originX) / BEV.mpp);
    const py = Math.round((y - BEV.originY) / BEV.mpp);
    if (px >= 0 && py >= 0 && px < BEV.size && py < BEV.size) {
      const idx = (py * BEV.size + px) * 4;
      raster[idx] = 150; raster[idx+1] = 150; raster[idx+2] = 160; raster[idx+3] = 255;
    }
  }
}
{
  const w = BEV.size, h = BEV.size, stride = w * 3;
  const buf = Buffer.alloc(54 + stride * h);
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const s = ((h - 1 - row) * w + col) * 4, d = 54 + row * stride + col * 3;
    buf[d] = raster[s+2]; buf[d+1] = raster[s+1]; buf[d+2] = raster[s];
  }
  put('bev/0/0/0.bmp', buf);
}

// manifest v2
const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const manifest = {
  formatVersion: 2,
  datasetId: 'r-mini-kitti-0011',
  datasetVersion: '1.0.0',
  contentHash: '',
  worldConvention: { up: 'z', units: 'meter', angleUnit: 'radian', originNote: 'ENU frame at first oxts sample' },
  referenceFrames: Array.from({ length: FRAMES }, (_, f) => ({ frameId: f, timeUs: f * 100000 })),
  pose: {
    source: 'kitti-oxts-enu',
    interpolation: 'linear-translation-slerp-rotation',
    maxGapUs: 100000,
    frames: poses.map((p, f) => ({ frameId: f, timeUs: f * 100000, T_world_from_ego: p })),
  },
  sensors: [
    { sensorId: 'lidar', type: 'lidar', model: 'none', distortionState: 'raw', T_ego_from_sensor: veloToImu,
      timeSync: { toleranceUs: 5000, fallback: 'none' }, pcdTemplate: 'pcd/{frame}.pcd',
      pointCloud: { fields: ['x','y','z','intensity'], encoding: 'binary-pcd', bytesPerPoint: 16, motionDistorted: false, referenceTime: 'mid' } },
    { sensorId: 'cam2', type: 'camera', model: 'pinhole', distortionState: 'raw',
      distortion: [], intrinsics: { fx: P2[0], fy: P2[5], cx: P2[2], cy: P2[6] },
      width: 1242, height: 375,
      T_ego_from_sensor: T_ego_from_cam2,
      timeSync: { toleranceUs: 5000, fallback: 'none' }, imageTemplate: 'images/{frame}.png',
      notes: 'sensor frame = rectified cam2; chain velo -> cam2rect via R_rect_02/Tr (raw image, distortion NOT reapplied on undistorted-less pipeline)' },
  ],
  bev: {
    tileset: { originX: BEV.originX, originY: BEV.originY, metersPerPixel: BEV.mpp, width: BEV.size, height: BEV.size, tileSize: BEV.size, urlTemplate: 'bev/0/0/0.bmp', pixelCenter: 'top-left-center', axisNote: 'image +x -> world +x, image +y -> world +y; rasterized from the same lidar frames' },
  },
  resources: Object.entries(checksums).map(([rel, s]) => ({ resourceId: rel, uri: rel, sha256: s })),
};
const canon = JSON.stringify(manifest, Object.keys(manifest).sort());
manifest.contentHash = 'sha256:' + createHash('sha256').update(canon).digest('hex');
put('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
const reference = {
  note: 'Independent reference from official KITTI tracking labels (human annotations), Z-up world, box center = geometric center, half-open existence implied by frame list.',
  sourceSequence: 'kitti_tracking_0011 / 2011_09_26_drive_0084',
  tracks: [...referenceTracks.values()],
};
put('reference-answers.json', Buffer.from(JSON.stringify(reference, null, 2)));
writeFileSync(join(OUT, 'checksums.json'), JSON.stringify(checksums, null, 2));
console.log(`r-mini assembled: ${FRAMES} frames, ${referenceTracks.size} reference tracks, ${Object.keys(checksums).length} files`);

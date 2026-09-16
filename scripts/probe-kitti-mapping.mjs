#!/usr/bin/env node
// Empirically matches a KITTI tracking sequence to a raw drive:
// transforms label boxes (cam0-rect) into the velo frame and counts
// in-box points at drive frame 0. The correct pair lights up.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = process.argv[2];
const driveRoot = process.argv[3];
const candidates = process.argv.slice(4);

function parseCalib(path) {
  const mats = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) mats[m[1]] = m[2].trim().split(/\s+/).map(Number);
  }
  return mats;
}
function invertRt(r, t) {
  // R orthonormal: inverse = R^T, -R^T t
  const R = [[r[0], r[1], r[2]], [r[3], r[4], r[5]], [r[6], r[7], r[8]]];
  const Rt = [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]];
  return { R: Rt, t: [
    -(Rt[0][0] * t[0] + Rt[0][1] * t[1] + Rt[0][2] * t[2]),
    -(Rt[1][0] * t[0] + Rt[1][1] * t[1] + Rt[1][2] * t[2]),
    -(Rt[2][0] * t[0] + Rt[2][1] * t[1] + Rt[2][2] * t[2]),
  ] };
}
function apply(Rt, t, p) {
  return [
    Rt[0][0] * p[0] + Rt[0][1] * p[1] + Rt[0][2] * p[2] + t[0],
    Rt[1][0] * p[0] + Rt[1][1] * p[1] + Rt[1][2] * p[2] + t[1],
    Rt[2][0] * p[0] + Rt[2][1] * p[1] + Rt[2][2] * p[2] + t[2],
  ];
}

// raw calib: cam0-rect -> velo  =  Tr^-1  o  R0^-1
const camToCam = parseCalib(join(workDir, 'calib_date/2011_09_26/calib_cam_to_cam.txt'));
const veloToCamFile = parseCalib(join(workDir, 'calib_date/2011_09_26/calib_velo_to_cam.txt'));
const R0 = camToCam.R_rect_00.slice(0, 9);
const R0t = [R0[0], R0[3], R0[6], R0[1], R0[4], R0[7], R0[2], R0[5], R0[8]];
const R = veloToCamFile.R;
const T = veloToCamFile.T;
const veloFromCam0 = invertRt(R, T);
const veloFromRect = (() => {
  // composed: rect -> cam0 (R0^T) -> velo (Tr^-1), all nested row-major
  const R0tM = [
    [R0t[0], R0t[1], R0t[2]],
    [R0t[3], R0t[4], R0t[5]],
    [R0t[6], R0t[7], R0t[8]],
  ];
  const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      R[r][c] =
        veloFromCam0.R[r][0] * R0tM[0][c] +
        veloFromCam0.R[r][1] * R0tM[1][c] +
        veloFromCam0.R[r][2] * R0tM[2][c];
    }
  }
  return { R, t: veloFromCam0.t };
})();

const bin = readFileSync(join(workDir, driveRoot, 'velodyne_points/data/0000000000.bin'));
const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
const count = Math.floor(bin.byteLength / 16);
const pts = new Float32Array(count * 3);
for (let i = 0; i < count; i++) {
  pts[i * 3] = view.getFloat32(i * 16, true);
  pts[i * 3 + 1] = view.getFloat32(i * 16 + 4, true);
  pts[i * 3 + 2] = view.getFloat32(i * 16 + 8, true);
}

function inBoxScore(boxes) {
  let total = 0;
  const perBox = [];
  for (const box of boxes) {
    const velo = apply(veloFromRect.R, veloFromRect.t, [box.x, box.y - box.h / 2, box.z]);
    const yaw = (() => {
      // rotate heading dir rect->velo; velo frame: x fwd, y left, z up
      const d = [Math.sin(box.ry), 0, Math.cos(box.ry)];
      const dv = apply(veloFromRect.R, [0, 0, 0], d);
      return Math.atan2(dv[1], dv[0]);
    })();
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const hl = box.l / 2, hw = box.w / 2;
    let inside = 0;
    for (let i = 0; i < count; i += 2) {
      const dx = pts[i * 3] - velo[0];
      const dy = pts[i * 3 + 1] - velo[1];
      const dz = pts[i * 3 + 2] - velo[2];
      if (dz < -0.5 || dz > box.h) continue; // allow small ground drop
      const lx = dx * c + dy * s;
      const ly = -dx * s + dy * c;
      if (Math.abs(lx) <= hl && Math.abs(ly) <= hw) inside++;
    }
    perBox.push(inside);
    total += inside;
  }
  return { total, perBox };
}

for (const seq of candidates) {
  const lines = readFileSync(join(workDir, `labels/training/label_02/${seq}.txt`), 'utf8').split(/\r?\n/).filter(Boolean);
  const byFrame = new Map();
  for (const l of lines) {
    const p = l.split(/\s+/);
    if (!['Car', 'Van', 'Pedestrian', 'Truck'].includes(p[2])) continue;
    if (!byFrame.has(p[0])) byFrame.set(p[0], []);
    byFrame.get(p[0]).push({ x: +p[13], y: +p[14], z: +p[15], h: +p[10], w: +p[11], l: +p[12], ry: +p[16] });
  }
  const probes = [0, 50, 100, 150, 200, 250, 300, 350];
  const scores = probes.map((f) => {
    let pts2 = pts;
    let count2 = count;
    if (f > 0) {
      try {
        const b = readFileSync(join(workDir, driveRoot, `velodyne_points/data/${String(f).padStart(10, '0')}.bin`));
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        count2 = Math.floor(b.byteLength / 16);
        pts2 = new Float32Array(count2 * 3);
        for (let i = 0; i < count2; i++) {
          pts2[i * 3] = v.getFloat32(i * 16, true);
          pts2[i * 3 + 1] = v.getFloat32(i * 16 + 4, true);
          pts2[i * 3 + 2] = v.getFloat32(i * 16 + 8, true);
        }
      } catch {
        return -1;
      }
    }
    const boxes = byFrame.get(String(f)) ?? [];
    let total = 0;
    for (const box of boxes) {
      const velo = apply(veloFromRect.R, veloFromRect.t, [box.x, box.y - box.h / 2, box.z]);
      const d = [Math.sin(box.ry), 0, Math.cos(box.ry)];
      const dv = apply(veloFromRect.R, [0, 0, 0], d);
      const yaw = Math.atan2(dv[1], dv[0]);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const hl = box.l / 2, hw = box.w / 2;
      for (let i = 0; i < count2; i += 2) {
        const dx = pts2[i * 3] - velo[0];
        const dy = pts2[i * 3 + 1] - velo[1];
        const dz = pts2[i * 3 + 2] - velo[2];
        if (dz < -0.5 || dz > box.h) continue;
        const lx = dx * c + dy * s;
        const ly = -dx * s + dy * c;
        if (Math.abs(lx) <= hl && Math.abs(ly) <= hw) total++;
      }
    }
    return total;
  });
  console.log(`seq ${seq}: [${probes.map((f, i) => `${f}:${scores[i]}`).join(' ')}]`);
}

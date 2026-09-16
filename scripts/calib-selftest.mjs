#!/usr/bin/env node
// Calibration-math self test: mat34 + inverse + the full label chain must
// reproduce the probe-validated velo-frame result.
import { readFileSync } from 'node:fs';

function parseCalib(path) {
  const mats = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) mats[m[1]] = m[2].trim().split(/\s+/).map(Number);
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

function apply(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      o[col * 4 + row] = sum;
    }
  }
  return o;
}

function invert(m) {
  // general 4x4 via adjugate (gl-matrix formula)
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  det = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}

const calib = parseCalib('/tmp/kitti4d/calib_date/2011_09_26/calib_velo_to_cam.txt');
const R = calib.R, T = calib.T;

// 1) mat34 must reproduce R*x + T computed directly (row-major loop)
const M = mat34(R, T);
const x = [3, -1, 42];
const direct2 = [0, 0, 0];
for (let r = 0; r < 3; r++) {
  direct2[r] = R[r * 3] * x[0] + R[r * 3 + 1] * x[1] + R[r * 3 + 2] * x[2] + T[r];
}
console.log('M*x      =', apply(M, x).map((v) => v.toFixed(3)));
console.log('R*x+T    =', direct2.map((v) => v.toFixed(3)));
console.log('M origin =', apply(M, [0, 0, 0]).map((v) => v.toFixed(3)), ' T =', T.map((v) => v.toFixed(3)));

// 2) inverse round trip
const Mi = invert(M);
console.log('inv(M)*x =', apply(Mi, direct2).map((v) => v.toFixed(6)), '(expect velo frame of the test point)');

// 3) full label chain for the first frame-0 Car of tracking 0011
const cam = parseCalib('/tmp/kitti4d/calib_date/2011_09_26/calib_cam_to_cam.txt');
const imu = parseCalib('/tmp/kitti4d/calib_date/2011_09_26/calib_imu_to_velo.txt');
const rectInv = mat34(
  [cam.R_rect_00[0], cam.R_rect_00[3], cam.R_rect_00[6], cam.R_rect_00[1], cam.R_rect_00[4], cam.R_rect_00[7], cam.R_rect_00[2], cam.R_rect_00[5], cam.R_rect_00[8]],
  [0, 0, 0]
);
const camRectToVelo = mul(invert(mat34(R, T)), rectInv);
const veloToImu = invert(mat34(imu.R, imu.T));
const label = { x: -0.056219, y: 1.57742 - 1.558617 / 2, z: 15.254058 };
const velo = apply(camRectToVelo, [label.x, label.y, label.z]);
console.log('label→velo =', velo.map((v) => v.toFixed(2)), '(expect x≈15, small y/z — ahead of the car)');

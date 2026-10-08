/**
 * Pure math for 4D annotation. World frame: Y-up, ground plane = XZ,
 * yaw = rotation about +Y, 0 yaw faces +X. All matrices are 4x4 column-major
 * (three.js compatible), stored as Float64Array(16) or number[].
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const TAU = Math.PI * 2;

/** Normalize to (-PI, PI]. */
export function normalizeYaw(yaw: number): number {
  let y = yaw % TAU;
  if (y <= -Math.PI) y += TAU;
  else if (y > Math.PI) y -= TAU;
  return y;
}

/** Interpolate yaw along the shortest arc. */
export function lerpYaw(a: number, b: number, t: number): number {
  const delta = normalizeYaw(b - a);
  return normalizeYaw(a + delta * t);
}

export function yawQuaternion(yaw: number, out: Float32Array | number[]): void {
  const half = yaw / 2;
  out[0] = 0;
  out[1] = Math.sin(half);
  out[2] = 0;
  out[3] = Math.cos(half);
}

/** Column-major 4x4: translation * rotationY(yaw) * scale(size). */
export function composeBoxMatrix(
  pos: Vec3,
  yaw: number,
  size: Vec3,
  out: Float32Array
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // rotationY then scale: columns scaled by size components
  out[0] = c * size.x;
  out[1] = 0;
  out[2] = -s * size.x;
  out[3] = 0;
  out[4] = 0;
  out[5] = size.y;
  out[6] = 0;
  out[7] = 0;
  out[8] = s * size.z;
  out[9] = 0;
  out[10] = c * size.z;
  out[11] = 0;
  out[12] = pos.x;
  out[13] = pos.y;
  out[14] = pos.z;
  out[15] = 1;
}

/** 8 corners of an OBB, xyz triplets into out (length 24). Order: bottom 4 (y-), top 4 (y+). */
export function boxCorners(
  pos: Vec3,
  yaw: number,
  size: Vec3,
  out: Float64Array | number[]
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hx = size.x / 2;
  const hz = size.z / 2;
  const hy = size.y / 2;
  const localX = [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ];
  for (let i = 0; i < 4; i++) {
    const [lx, lz] = localX[i];
    const wx = pos.x + lx * c + lz * s;
    const wz = pos.z + -lx * s + lz * c;
    out[i * 3] = wx;
    out[i * 3 + 1] = pos.y - hy;
    out[i * 3 + 2] = wz;
    out[(i + 4) * 3] = wx;
    out[(i + 4) * 3 + 1] = pos.y + hy;
    out[(i + 4) * 3 + 2] = wz;
  }
}

export function mat4Multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): void {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
}

export function mat4Invert(m: ArrayLike<number>, out: Float64Array): boolean {
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
  if (!det) return false;
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return true;
}

export function transformPoint(m: ArrayLike<number>, p: Vec3, out: Vec3): void {
  const x = p.x, y = p.y, z = p.z;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out.x = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out.y = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out.z = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
}

/** Intersect ray with ground plane y = planeY. Returns null when parallel or behind. */
export function rayGround(origin: Vec3, dir: Vec3, planeY = 0): Vec3 | null {
  if (Math.abs(dir.y) < 1e-8) return null;
  const t = (planeY - origin.y) / dir.y;
  if (t < 0) return null;
  return vec3(origin.x + dir.x * t, planeY, origin.z + dir.z * t);
}

/**
 * Slab test of ray against OBB. Ray is transformed into the box frame
 * (inverse of translation + yaw: local = R_y(-yaw) · (world - pos)).
 * Returns entry distance t >= 0, or null.
 */
export function rayOBB(
  origin: Vec3,
  dir: Vec3,
  pos: Vec3,
  yaw: number,
  size: Vec3
): number | null {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ox = origin.x - pos.x;
  const oz = origin.z - pos.z;
  const ro = { x: ox * c - oz * s, y: origin.y - pos.y, z: ox * s + oz * c };
  const rd = { x: dir.x * c - dir.z * s, y: dir.y, z: dir.x * s + dir.z * c };
  const h = { x: size.x / 2, y: size.y / 2, z: size.z / 2 };

  let tmin = 0;
  let tmax = Infinity;
  const axes: [number, number, number] = [ro.x, ro.y, ro.z];
  const dirs: [number, number, number] = [rd.x, rd.y, rd.z];
  const half: [number, number, number] = [h.x, h.y, h.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dirs[i]) < 1e-9) {
      if (Math.abs(axes[i]) > half[i]) return null;
      continue;
    }
    let t1 = (-half[i] - axes[i]) / dirs[i];
    let t2 = (half[i] - axes[i]) / dirs[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Point in polygon (ray casting), pts = flat [x0,y0,x1,y1,...]. */
export function pointInPolygon(px: number, py: number, pts: ArrayLike<number>, count: number): boolean {
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = pts[i * 2];
    const yi = pts[i * 2 + 1];
    const xj = pts[j * 2];
    const yj = pts[j * 2 + 1];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Convex hull (monotone chain) over flat [x,y,...] points; returns flat hull CCW. */
export function convexHull(pts: number[]): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => pts[a * 2] - pts[b * 2] || pts[a * 2 + 1] - pts[b * 2 + 1]);
  const cross = (o: number, a: number, b: number) =>
    (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) -
    (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  upper.pop();
  lower.pop();
  const out: number[] = [];
  for (const i of [...lower, ...upper]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

/** Bilinear sample of a single-channel grid. */
export function bilinear(data: ArrayLike<number>, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = data[y0 * width + x0];
  const v10 = data[y0 * width + x1];
  const v01 = data[y1 * width + x0];
  const v11 = data[y1 * width + x1];
  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
}

/** Distance from point to segment (2D). */
export function pointSegmentDistance(
  px: number, py: number, ax: number, ay: number, bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

/** Shared transient selection transform; never writes authoritative geometry. */
export function previewPose(id: string, pos: Vec3, yaw: number, preview: {
  ids: Set<string>; delta: Vec3; pivot?: Vec3; dyaw?: number;
} | null): { pos: Vec3; yaw: number } {
  if (!preview || !preview.ids.has(id)) return { pos, yaw };
  let x = pos.x + preview.delta.x, z = pos.z + preview.delta.z;
  if (preview.pivot && preview.dyaw) {
    const dx = x - preview.pivot.x, dz = z - preview.pivot.z;
    const c = Math.cos(preview.dyaw), s = Math.sin(preview.dyaw);
    x = preview.pivot.x + dx * c + dz * s;
    z = preview.pivot.z - dx * s + dz * c;
  }
  return { pos: { x, y: pos.y + preview.delta.y, z }, yaw: yaw + (preview.dyaw ?? 0) };
}

/** Full-pose source observations and yaw-only editable boxes share corner ordering. */
export function stateBoxCorners(state: { pos: Vec3; yaw: number; size: Vec3; boxToWorld?: readonly number[] }, out: Float64Array): void {
  if (!state.boxToWorld) { boxCorners(state.pos, state.yaw, state.size, out); return; }
  const local = new Float64Array(24);
  boxCorners({ x: 0, y: 0, z: 0 }, 0, state.size, local);
  const point = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 8; i++) {
    transformPoint(state.boxToWorld, { x: local[i*3], y: local[i*3+1], z: local[i*3+2] }, point);
    out.set([point.x, point.y, point.z], i*3);
  }
}
export function stateBoxMatrix(state: { pos: Vec3; yaw: number; size: Vec3; boxToWorld?: readonly number[] }, out: Float32Array): void {
  if (!state.boxToWorld) { composeBoxMatrix(state.pos, state.yaw, state.size, out); return; }
  out.set(state.boxToWorld);
  for (let col = 0; col < 3; col++) {
    const scale = [state.size.x, state.size.y, state.size.z][col];
    for (let row = 0; row < 3; row++) out[col*4+row] *= scale;
  }
}

import type { KeyframeState, SerializedGeometry, SerializedTrack, TrackMeta } from './types';

export function validateRange(start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error('Invalid existence interval');
  }
}

export function validateState(state: KeyframeState): void {
  const values = [state.pos.x, state.pos.y, state.pos.z, state.yaw, state.size.x, state.size.y, state.size.z];
  if (!values.every(Number.isFinite) || [state.size.x, state.size.y, state.size.z].some((v) => v <= 0)) {
    throw new Error('Box coordinates must be finite and dimensions positive');
  }
}

export function validateMeta(meta: TrackMeta): void {
  if (!meta || typeof meta.id !== 'string' || !meta.id || typeof meta.label !== 'string' || !meta.label) {
    throw new Error('Track identity and label are required');
  }
  validateRange(meta.startFrame, meta.endFrame);
  if (!['linear', 'hold'].includes(meta.interpolation) || !['human', 'model'].includes(meta.source)) {
    throw new Error('Invalid track metadata');
  }
  validateAttributes(meta.attributes);
}

export function validateAttributes(attrs: Record<string, unknown>): void {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs) || Object.values(attrs).some((v) =>
    !['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v)))) {
    throw new Error('Invalid attributes');
  }
}

export function validateTrack(track: SerializedTrack): void {
  validateMeta(track.meta);
  const k = track.keyframes;
  const n = k?.frames?.length;
  if (!n || !Array.isArray(k.frames) || k.pos.length !== 3 * n || k.yaw.length !== n || k.size.length !== 3 * n) {
    throw new Error('Invalid keyframe columns');
  }
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const f = k.frames[i];
    if (!Number.isSafeInteger(f) || f < track.meta.startFrame || f > track.meta.endFrame || seen.has(f)) {
      throw new Error('Keyframes must be unique and inside the existence interval');
    }
    seen.add(f);
    validateState({ pos: { x: k.pos[i * 3], y: k.pos[i * 3 + 1], z: k.pos[i * 3 + 2] },
      yaw: k.yaw[i], size: { x: k.size[i * 3], y: k.size[i * 3 + 1], z: k.size[i * 3 + 2] } });
  }
  for (const entry of track.frameAttributes ?? []) {
    if (!Number.isSafeInteger(entry.frame) || entry.frame < track.meta.startFrame || entry.frame > track.meta.endFrame) {
      throw new Error('Attribute frame is outside the existence interval');
    }
    validateAttributes(entry.attrs);
  }
}

export function validateGeometry(geometry: SerializedGeometry): void {
  const { meta, vertices } = geometry;
  if (!meta?.id || !meta.label) throw new Error('Geometry identity and label are required');
  validateRange(meta.startFrame, meta.endFrame);
  validateAttributes(meta.attributes);
  if (vertices.length % 3 || vertices.length < (meta.closed ? 9 : 6) || !vertices.every(Number.isFinite)) {
    throw new Error('Invalid geometry vertices');
  }
  const n = vertices.length / 3;
  const unique = new Set(Array.from({ length: n }, (_, i) => vertices.slice(i * 3, i * 3 + 3).join(',')));
  if (unique.size < (meta.closed ? 3 : 2)) throw new Error('Geometry requires distinct vertices');
  if (meta.closed) {
    const orient = (a: number, b: number, c: number) =>
      (vertices[b * 3] - vertices[a * 3]) * (vertices[c * 3 + 2] - vertices[a * 3 + 2]) -
      (vertices[b * 3 + 2] - vertices[a * 3 + 2]) * (vertices[c * 3] - vertices[a * 3]);
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      const a2 = (a + 1) % n, b2 = (b + 1) % n;
      if (a === b2 || a2 === b) continue;
      if (orient(a, a2, b) * orient(a, a2, b2) < 0 && orient(b, b2, a) * orient(b, b2, a2) < 0) {
        throw new Error('Self-intersecting polygon');
      }
    }
  }
}

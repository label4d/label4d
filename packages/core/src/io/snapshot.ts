import type { TrackStore } from '../model/TrackStore';
import type { SerializedGeometry, SerializedTrack, TrackMeta } from '../model/types';

// ---- pure-JS base64 (browser + node safe, chunked to avoid stack overflow) ----

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? B64_ALPHABET[b2 & 63] : '=';
  }
  return out;
}

const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64_ALPHABET.length; i++) B64_LOOKUP[B64_ALPHABET.charCodeAt(i)] = i;

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const len = clean.length;
  const pad = (4 - (len % 4)) % 4;
  const padded = clean + '='.repeat(pad);
  const out = new Uint8Array((padded.length / 4) * 3);
  let o = 0;
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = B64_LOOKUP[padded.charCodeAt(i)];
    const c1 = B64_LOOKUP[padded.charCodeAt(i + 1)];
    const c2 = B64_LOOKUP[padded.charCodeAt(i + 2)];
    const c3 = B64_LOOKUP[padded.charCodeAt(i + 3)];
    if (c1 >= 0) out[o++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (c3 >= 0) out[o++] = ((c2 & 3) << 6) | c3;
  }
  return out.subarray(0, o);
}

// ---- snapshot document ----

export interface SnapshotQA {
  status: 'pending' | 'pass' | 'reject';
  notes?: string;
}

export interface BinaryKeyframes {
  count: number;
  frames: string; // base64 Int32Array
  pos: string; // base64 Float32Array 3k
  yaw: string; // base64 Float32Array k
  size: string; // base64 Float32Array 3k
}

export interface SnapshotTrack {
  meta: TrackMeta;
  kf: BinaryKeyframes;
  frameAttributes?: Array<{ frame: number; attrs: Record<string, string | number | boolean> }>;
}

export interface SnapshotDocument {
  formatVersion: 1;
  sequenceId: string;
  frameCount: number;
  createdAt: string;
  qa?: SnapshotQA;
  tracks: SnapshotTrack[];
  geometries: SerializedGeometry[];
}

export function serializeStore(
  store: TrackStore,
  info: { sequenceId: string; frameCount: number; qa?: SnapshotQA }
): SnapshotDocument {
  const tracks: SnapshotTrack[] = [];
  for (const record of store.listTracks()) {
    tracks.push({
      meta: { ...record.meta, attributes: { ...record.meta.attributes } },
      kf: {
        count: record.kf.frames.length,
        frames: bytesToBase64(new Uint8Array(record.kf.frames.buffer, record.kf.frames.byteOffset, record.kf.frames.byteLength)),
        pos: bytesToBase64(new Uint8Array(record.kf.pos.buffer, record.kf.pos.byteOffset, record.kf.pos.byteLength)),
        yaw: bytesToBase64(new Uint8Array(record.kf.yaw.buffer, record.kf.yaw.byteOffset, record.kf.yaw.byteLength)),
        size: bytesToBase64(new Uint8Array(record.kf.size.buffer, record.kf.size.byteOffset, record.kf.size.byteLength)),
      },
      frameAttributes:
        record.frameAttrs.size > 0
          ? Array.from(record.frameAttrs.entries()).map(([frame, attrs]) => ({ frame, attrs: { ...attrs } }))
          : undefined,
    });
  }
  const geometries = store
    .listGeometries()
    .map((g) => store.serializeGeometry(g.meta.id))
    .filter((g): g is SerializedGeometry => !!g);
  return {
    formatVersion: 1,
    sequenceId: info.sequenceId,
    frameCount: info.frameCount,
    createdAt: new Date().toISOString(),
    qa: info.qa,
    tracks,
    geometries,
  };
}

/** Accepts canonical binary keyframes or plain-array keyframes (external imports). */
function normalizeSnapshotTrack(t: SnapshotTrack): SnapshotTrack {
  const kf = (t as { kf?: { count?: number; frames?: unknown }; keyframes?: SerializedTrack['keyframes'] });
  if (typeof kf.kf?.frames === 'string') return t; // canonical binary form
  const plain = kf.keyframes ?? (kf.kf as unknown as SerializedTrack['keyframes']);
  if (!plain || !Array.isArray(plain.frames)) {
    throw new Error(`snapshot track ${String((t.meta as { id?: string }).id)}: no keyframes`);
  }
  const count = plain.frames.length;
  return {
    ...t,
    kf: {
      count,
      frames: bytesToBase64(new Uint8Array(new Int32Array(plain.frames).buffer)),
      pos: bytesToBase64(new Uint8Array(new Float32Array(plain.pos).buffer)),
      yaw: bytesToBase64(new Uint8Array(new Float32Array(plain.yaw).buffer)),
      size: bytesToBase64(new Uint8Array(new Float32Array(plain.size).buffer)),
    },
  };
}

export function applySnapshot(store: TrackStore, doc: SnapshotDocument): void {
  for (const raw of doc.tracks) {
    const t = normalizeSnapshotTrack(raw as SnapshotTrack);
    const framesBytes = base64ToBytes(t.kf.frames);
    const posBytes = base64ToBytes(t.kf.pos);
    const yawBytes = base64ToBytes(t.kf.yaw);
    const sizeBytes = base64ToBytes(t.kf.size);
    if (
      framesBytes.length < t.kf.count * 4 ||
      posBytes.length < t.kf.count * 12 ||
      yawBytes.length < t.kf.count * 4 ||
      sizeBytes.length < t.kf.count * 12
    ) {
      throw new Error(`snapshot track ${String(t.meta.id)}: keyframe payload truncated`);
    }
    const frames = new Int32Array(framesBytes.buffer, framesBytes.byteOffset, t.kf.count);
    const pos = new Float32Array(posBytes.buffer, posBytes.byteOffset, t.kf.count * 3);
    const yaw = new Float32Array(yawBytes.buffer, yawBytes.byteOffset, t.kf.count);
    const size = new Float32Array(sizeBytes.buffer, sizeBytes.byteOffset, t.kf.count * 3);
    store.restoreTrack({
      meta: t.meta,
      keyframes: {
        frames: Array.from(frames),
        pos: Array.from(pos),
        yaw: Array.from(yaw),
        size: Array.from(size),
      },
      frameAttributes: t.frameAttributes,
    });
  }
  for (const g of doc.geometries) store.restoreGeometry(g);
}


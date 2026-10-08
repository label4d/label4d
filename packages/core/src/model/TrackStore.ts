import type { ObservationSource } from '../dataset/DatasetProvider';
import { EventEmitter } from '../events/EventEmitter';
import { validateAttributes, validateGeometry, validateMeta, validateState, validateTrack } from './validation';
import { lerp, lerpYaw } from '../geometry/math';
import type {
  GeometryId,
  GeometryMeta,
  KeyframeData,
  KeyframeState,
  ResolvedState,
  SerializedGeometry,
  SerializedKeyframes,
  SerializedTrack,
  TrackId,
  TrackMeta,
} from './types';

export interface TrackRecord {
  meta: TrackMeta;
  kf: KeyframeData;
  /** sparse per-frame attribute overrides keyed by frame */
  frameAttrs: Map<number, Record<string, string | number | boolean>>;
}

export interface GeometryRecord {
  meta: GeometryMeta;
  vertices: Float32Array; // xyz triplets
}

export interface StoreChange {
  version: number;
  /** null = structural change affecting everything */
  tracks: Set<TrackId> | null;
  geometries: Set<GeometryId> | null;
}

export interface TrackStoreEvents {
  changed: StoreChange;
}

export interface StorePatch {
  tracks: Array<{ id: string; value: SerializedTrack | null }>;
  geometries: Array<{ id: string; value: SerializedGeometry | null }>;
}

const emptyKeyframes = (): KeyframeData => ({
  frames: new Int32Array(0),
  pos: new Float32Array(0),
  yaw: new Float32Array(0),
  size: new Float32Array(0),
});

function keyframesFromSerialized(s: SerializedKeyframes | undefined): KeyframeData {
  if (!s || s.frames.length === 0) return emptyKeyframes();
  const k = s.frames.length;
  const frames = new Int32Array(k);
  const pos = new Float32Array(k * 3);
  const yaw = new Float32Array(k);
  const size = new Float32Array(k * 3);
  // insertion sort by frame (inputs are usually already sorted)
  const order = Array.from({ length: k }, (_, i) => i);
  order.sort((a, b) => s.frames[a] - s.frames[b]);
  for (let out = 0; out < k; out++) {
    const src = order[out];
    frames[out] = s.frames[src];
    pos[out * 3] = s.pos[src * 3];
    pos[out * 3 + 1] = s.pos[src * 3 + 1];
    pos[out * 3 + 2] = s.pos[src * 3 + 2];
    yaw[out] = s.yaw[src];
    size[out * 3] = s.size[src * 3];
    size[out * 3 + 1] = s.size[src * 3 + 1];
    size[out * 3 + 2] = s.size[src * 3 + 2];
  }
  return { frames, pos, yaw, size };
}

function insertIntoColumns(
  kf: KeyframeData,
  frame: number,
  state: KeyframeState
): KeyframeData {
  const k = kf.frames.length;
  let idx = 0;
  while (idx < k && kf.frames[idx] < frame) idx++;
  const frames = new Int32Array(k + 1);
  const pos = new Float32Array((k + 1) * 3);
  const yaw = new Float32Array(k + 1);
  const size = new Float32Array((k + 1) * 3);
  frames.set(kf.frames.subarray(0, idx), 0);
  pos.set(kf.pos.subarray(0, idx * 3), 0);
  yaw.set(kf.yaw.subarray(0, idx), 0);
  size.set(kf.size.subarray(0, idx * 3), 0);
  frames[idx] = frame;
  pos[idx * 3] = state.pos.x;
  pos[idx * 3 + 1] = state.pos.y;
  pos[idx * 3 + 2] = state.pos.z;
  yaw[idx] = state.yaw;
  size[idx * 3] = state.size.x;
  size[idx * 3 + 1] = state.size.y;
  size[idx * 3 + 2] = state.size.z;
  frames.set(kf.frames.subarray(idx), idx + 1);
  pos.set(kf.pos.subarray(idx * 3), (idx + 1) * 3);
  yaw.set(kf.yaw.subarray(idx), idx + 1);
  size.set(kf.size.subarray(idx * 3), (idx + 1) * 3);
  return { frames, pos, yaw, size };
}

function removeFromColumns(kf: KeyframeData, index: number): KeyframeData {
  const k = kf.frames.length;
  const frames = new Int32Array(k - 1);
  const pos = new Float32Array((k - 1) * 3);
  const yaw = new Float32Array(k - 1);
  const size = new Float32Array((k - 1) * 3);
  frames.set(kf.frames.subarray(0, index), 0);
  frames.set(kf.frames.subarray(index + 1), index);
  pos.set(kf.pos.subarray(0, index * 3), 0);
  pos.set(kf.pos.subarray((index + 1) * 3), index * 3);
  yaw.set(kf.yaw.subarray(0, index), 0);
  yaw.set(kf.yaw.subarray(index + 1), index);
  size.set(kf.size.subarray(0, index * 3), 0);
  size.set(kf.size.subarray((index + 1) * 3), index * 3);
  return { frames, pos, yaw, size };
}

function stateAt(kf: KeyframeData, i: number): KeyframeState {
  return {
    pos: { x: kf.pos[i * 3], y: kf.pos[i * 3 + 1], z: kf.pos[i * 3 + 2] },
    yaw: kf.yaw[i],
    size: { x: kf.size[i * 3], y: kf.size[i * 3 + 1], z: kf.size[i * 3 + 2] },
  };
}

/**
 * The 4D document: tracked dynamic objects (keyframe columns with interval
 * index) plus static sequence-wide geometry. All mutators are raw — commands
 * in ../command wrap them into undoable units and own ID allocation.
 */
export class TrackStore {
  readonly events = new EventEmitter<TrackStoreEvents>();

  private source: ObservationSource | null = null;
  /** Bind immutable source observations for browsing, separately from the editable document. */
  setObservationSource(source: ObservationSource | null): void {
    this.source = source; this.touch(null);
  }
  private version = 0;
  private trackMap = new Map<TrackId, TrackRecord>();
  private trackOrder: TrackId[] = [];
  private geometryMap = new Map<GeometryId, GeometryRecord>();
  private geometryOrder: GeometryId[] = [];
  private intervalIndex: { ids: TrackId[]; starts: Int32Array } | null = null;
  private trackCounter = 0;
  private geometryCounter = 0;
  private transaction: { tracks: Map<string, TrackRecord | undefined>; geometries: Map<string, GeometryRecord | undefined>; changed: boolean } | null = null;

  /** Evaluate an edit without publishing it. The returned patches contain only affected aggregates. */
  stage(fn: () => void): { before: StorePatch; after: StorePatch } {
    if (this.transaction) throw new Error('Cannot stage inside another transaction');
    const tx = { tracks: new Map<string, TrackRecord | undefined>(), geometries: new Map<string, GeometryRecord | undefined>(), changed: false };
    const order = this.trackOrder.slice(), geometryOrder = this.geometryOrder.slice();
    this.transaction = tx;
    try {
      fn();
      const after: StorePatch = {
        tracks: [...tx.tracks.keys()].map((id) => ({ id, value: this.serializeTrack(id) })),
        geometries: [...tx.geometries.keys()].map((id) => ({ id, value: this.serializeGeometry(id) })),
      };
      const before: StorePatch = {
        tracks: [...tx.tracks].map(([id, r]) => ({ id, value: r ? {
          meta: structuredClone(r.meta), keyframes: { frames: [...r.kf.frames], pos: [...r.kf.pos], yaw: [...r.kf.yaw], size: [...r.kf.size] },
          frameAttributes: [...r.frameAttrs].map(([frame, attrs]) => ({ frame, attrs: { ...attrs } })),
        } : null })),
        geometries: [...tx.geometries].map(([id, r]) => ({ id, value: r ? { meta: structuredClone(r.meta), vertices: [...r.vertices] } : null })),
      };
      return { before, after };
    } finally {
      for (const [id, r] of tx.tracks) { if (r) this.trackMap.set(id, r); else this.trackMap.delete(id); }
      for (const [id, r] of tx.geometries) { if (r) this.geometryMap.set(id, r); else this.geometryMap.delete(id); }
      this.trackOrder = order; this.geometryOrder = geometryOrder;
      this.intervalIndex = null; this.transaction = null;
    }
  }

  applyPatch(patch: StorePatch): void {
    if (!patch || !Array.isArray(patch.tracks) || !Array.isArray(patch.geometries)) throw new Error('Invalid document patch');
    const ids = new Set<string>();
    for (const entry of [...patch.tracks, ...patch.geometries]) {
      if (!entry.id || ids.has(entry.id) || (entry.value && entry.value.meta.id !== entry.id)) throw new Error('Invalid patch identity');
      ids.add(entry.id);
    }
    this.atomic(() => {
      for (const { id, value } of patch.tracks) { if (value) this.restoreTrack(value); else this.deleteTrack(id); }
      for (const { id, value } of patch.geometries) { if (value) this.restoreGeometry(value); else this.deleteGeometry(id); }
    });
  }

  /** Copy only affected aggregates; publish one change after a successful transaction. */
  atomic(fn: () => void): void {
    if (this.transaction) { fn(); return; }
    const tx = { tracks: new Map<string, TrackRecord | undefined>(), geometries: new Map<string, GeometryRecord | undefined>(), changed: false };
    const order = this.trackOrder.slice(), geometryOrder = this.geometryOrder.slice();
    this.transaction = tx;
    try { fn(); } catch (error) {
      for (const [id, record] of tx.tracks) { if (record) this.trackMap.set(id, record); else this.trackMap.delete(id); }
      for (const [id, record] of tx.geometries) { if (record) this.geometryMap.set(id, record); else this.geometryMap.delete(id); }
      this.trackOrder = order; this.geometryOrder = geometryOrder;
      this.intervalIndex = null;
      throw error;
    } finally { this.transaction = null; }
    if (tx.changed) this.touch(new Set(tx.tracks.keys()), new Set(tx.geometries.keys()));
  }

  private captureTrack(id: string): void {
    if (this.source) throw new Error('Source observations are immutable');
    const tx = this.transaction;
    if (!tx || tx.tracks.has(id)) return;
    const record = this.trackMap.get(id);
    tx.tracks.set(id, record ? { meta: structuredClone(record.meta), kf: record.kf,
      frameAttrs: new Map([...record.frameAttrs].map(([f, attrs]) => [f, { ...attrs }])) } : undefined);
  }

  private captureGeometry(id: string): void {
    if (this.source) throw new Error('Source observations are immutable');
    const tx = this.transaction;
    if (!tx || tx.geometries.has(id)) return;
    const record = this.geometryMap.get(id);
    tx.geometries.set(id, record ? { meta: structuredClone(record.meta), vertices: record.vertices } : undefined);
  }

  clear(): void {
    this.atomic(() => {
      for (const id of this.trackMap.keys()) this.deleteTrack(id);
      for (const id of this.geometryMap.keys()) this.deleteGeometry(id);
    });
  }

  replaceWith(other: TrackStore): void {
    this.atomic(() => {
      this.clear();
      for (const track of other.listTracks()) this.restoreTrack(other.serializeTrack(track.meta.id)!);
      for (const geometry of other.listGeometries()) this.restoreGeometry(other.serializeGeometry(geometry.meta.id)!);
    });
  }

  get currentVersion(): number {
    return this.version;
  }

  nextTrackId(): TrackId {
    let id: string;
    do { id = `trk_${String(++this.trackCounter).padStart(6, '0')}`; } while (this.trackMap.has(id));
    return id;
  }

  nextGeometryId(): GeometryId {
    let id: string;
    do { id = `geo_${String(++this.geometryCounter).padStart(6, '0')}`; } while (this.geometryMap.has(id));
    return id;
  }

  private touch(tracks?: Set<TrackId> | null, geometries?: Set<GeometryId> | null): void {
    if (this.transaction) { this.transaction.changed = true; this.intervalIndex = null; return; }
    this.version++;
    if (tracks === null || tracks === undefined) this.intervalIndex = null;
    else if (tracks.size > 0) this.intervalIndex = null;
    this.events.emit('changed', {
      version: this.version,
      tracks: tracks ?? null,
      geometries: geometries ?? null,
    });
  }

  // ---- tracks ----

  addTrack(
    meta: TrackMeta,
    keyframes?: SerializedKeyframes,
    frameAttributes?: Array<{ frame: number; attrs: Record<string, string | number | boolean> }>
  ): TrackRecord {
    this.captureTrack(meta.id);
    const frameAttrs = new Map<number, Record<string, string | number | boolean>>();
    for (const entry of frameAttributes ?? []) frameAttrs.set(entry.frame, { ...entry.attrs });
    const record: TrackRecord = { meta: structuredClone(meta), kf: keyframesFromSerialized(keyframes), frameAttrs };
    this.trackMap.set(meta.id, record);
    if (!this.trackOrder.includes(meta.id)) this.trackOrder.push(meta.id);
    this.touch(null);
    return record;
  }

  getTrack(id: TrackId): TrackRecord | undefined {
    return this.source?.records.get(id) ?? this.trackMap.get(id);
  }

  listTracks(): readonly TrackRecord[] {
    if (this.source) return [...this.source.records.values()];
    return this.trackOrder
      .map((id) => this.trackMap.get(id))
      .filter((r): r is TrackRecord => !!r);
  }

  get trackCount(): number {
    return this.source?.records.size ?? this.trackMap.size;
  }

  deleteTrack(id: TrackId): TrackRecord | undefined {
    this.captureTrack(id);
    const record = this.trackMap.get(id);
    if (!record) return undefined;
    this.trackMap.delete(id);
    this.trackOrder = this.trackOrder.filter((t) => t !== id);
    this.touch(null);
    return record;
  }

  setTrackMeta(id: TrackId, patch: Partial<Omit<TrackMeta, 'id'>>): void {
    this.captureTrack(id);
    const record = this.trackMap.get(id);
    if (!record) return;
    validateMeta({ ...record.meta, ...patch });
    if (Array.from(record.kf.frames).some((f) => f < (patch.startFrame ?? record.meta.startFrame) || f > (patch.endFrame ?? record.meta.endFrame))) {
      throw new Error('Existence interval cannot exclude keyframes');
    }
    Object.assign(record.meta, structuredClone(patch));
    this.touch(new Set([id]));
  }

  /** Track existence interval = union of meta range and keyframe range. */
  setTrackInterval(id: TrackId, startFrame: number, endFrame: number): void {
    this.setTrackMeta(id, { startFrame, endFrame });
  }

  setKeyframe(id: TrackId, frame: number, state: KeyframeState): void {
    this.captureTrack(id);
    const record = this.trackMap.get(id);
    if (!record) return;
    validateState(state);
    if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('Invalid keyframe index');
    const existing = record.kf.frames.indexOf(frame);
    if (existing >= 0) {
      const kf = record.kf;
      const pos = kf.pos.slice(), yaw = kf.yaw.slice(), size = kf.size.slice();
      pos.set([state.pos.x, state.pos.y, state.pos.z], existing * 3);
      yaw[existing] = state.yaw; size.set([state.size.x, state.size.y, state.size.z], existing * 3);
      record.kf = { frames: kf.frames, pos, yaw, size };
    } else {
      record.kf = insertIntoColumns(record.kf, frame, state);
    }
    // keyframes may extend outside meta interval; widen to keep invariant
    if (frame < record.meta.startFrame) record.meta.startFrame = frame;
    if (frame > record.meta.endFrame) record.meta.endFrame = frame;
    this.touch(new Set([id]));
  }

  removeKeyframe(id: TrackId, frame: number): KeyframeState | null {
    this.captureTrack(id);
    const record = this.trackMap.get(id);
    if (!record) return null;
    const idx = record.kf.frames.indexOf(frame);
    if (idx < 0) return null;
    if (record.kf.frames.length === 1) throw new Error('Cannot remove the last keyframe; delete the track instead');
    const removed = stateAt(record.kf, idx);
    record.kf = removeFromColumns(record.kf, idx);
    this.touch(new Set([id]));
    return removed;
  }

  getKeyframes(id: TrackId): KeyframeData | undefined {
    return this.getTrack(id)?.kf;
  }

  resolveState(id: TrackId, frame: number): ResolvedState | null {
    if (this.source) return this.source.states.get(id)?.get(frame) ?? null;
    const record = this.trackMap.get(id);
    if (!record) return null;
    const { meta, kf } = record;
    if (frame < meta.startFrame || frame > meta.endFrame || kf.frames.length === 0) return null;

    const frames = kf.frames;
    const k = frames.length;
    let lo = 0;
    let hi = k - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid] === frame) {
        idx = mid;
        break;
      }
      if (frames[mid] < frame) lo = mid + 1;
      else hi = mid - 1;
    }
    if (idx >= 0) {
      const s = stateAt(kf, idx);
      return { ...s, atKeyframe: true };
    }
    // insertion point = lo (first frame greater than query)
    if (lo <= 0) {
      const s = stateAt(kf, 0);
      return { ...s, atKeyframe: false };
    }
    if (lo >= k) {
      const s = stateAt(kf, k - 1);
      return { ...s, atKeyframe: false };
    }
    if (meta.interpolation === 'hold') {
      const s = stateAt(kf, lo - 1);
      return { ...s, atKeyframe: false };
    }
    const a = stateAt(kf, lo - 1);
    const b = stateAt(kf, lo);
    const t = (frame - frames[lo - 1]) / (frames[lo] - frames[lo - 1]);
    return {
      pos: {
        x: lerp(a.pos.x, b.pos.x, t),
        y: lerp(a.pos.y, b.pos.y, t),
        z: lerp(a.pos.z, b.pos.z, t),
      },
      yaw: lerpYaw(a.yaw, b.yaw, t),
      size: {
        x: lerp(a.size.x, b.size.x, t),
        y: lerp(a.size.y, b.size.y, t),
        z: lerp(a.size.z, b.size.z, t),
      },
      atKeyframe: false,
    };
  }

  activeTrackIds(frame: number): TrackId[] {
    if (this.source) return this.source.active[frame]?.slice() ?? [];
    if (this.intervalIndex === null) this.rebuildIntervalIndex();
    const index = this.intervalIndex;
    if (!index) return [];
    const out: TrackId[] = [];
    // starts is sorted; scan while start <= frame
    for (let i = 0; i < index.starts.length; i++) {
      if (index.starts[i] > frame) break;
      const id = index.ids[i];
      const rec = this.trackMap.get(id);
      if (rec && rec.meta.endFrame >= frame && rec.kf.frames.length > 0) out.push(id);
    }
    return out;
  }

  private rebuildIntervalIndex(): void {
    const entries = this.listTracks()
      .filter((r) => r.kf.frames.length > 0)
      .sort((a, b) => a.meta.startFrame - b.meta.startFrame);
    const starts = new Int32Array(entries.length);
    entries.forEach((r, i) => (starts[i] = r.meta.startFrame));
    this.intervalIndex = { ids: entries.map((r) => r.meta.id), starts };
  }

  setFrameAttribute(
    id: TrackId,
    frame: number,
    key: string,
    value: string | number | boolean | null
  ): void {
    const record = this.trackMap.get(id);
    if (!record) return;
    this.captureTrack(id);
    if (!Number.isSafeInteger(frame) || frame < record.meta.startFrame || frame > record.meta.endFrame) throw new Error('Invalid attribute frame');
    if (value !== null) validateAttributes({ [key]: value });
    let attrs = record.frameAttrs.get(frame);
    if (value === null) {
      if (attrs) {
        delete attrs[key];
        if (Object.keys(attrs).length === 0) record.frameAttrs.delete(frame);
      }
    } else {
      if (!attrs) {
        attrs = {};
        record.frameAttrs.set(frame, attrs);
      }
      attrs[key] = value;
    }
    this.touch(new Set([id]));
  }

  getFrameAttributes(id: TrackId, frame: number): Record<string, string | number | boolean> | undefined {
    return this.trackMap.get(id)?.frameAttrs.get(frame);
  }

  serializeTrack(id: TrackId): SerializedTrack | null {
    if (this.source) throw new Error('Source observations cannot be serialized as v1 tracks');
    const record = this.trackMap.get(id);
    if (!record) return null;
    const frameAttributes: NonNullable<SerializedTrack['frameAttributes']> = [];
    for (const [frame, attrs] of record.frameAttrs) {
      if (Object.keys(attrs).length > 0) frameAttributes.push({ frame, attrs: { ...attrs } });
    }
    return {
      meta: { ...record.meta, attributes: { ...record.meta.attributes } },
      keyframes: {
        frames: Array.from(record.kf.frames),
        pos: Array.from(record.kf.pos),
        yaw: Array.from(record.kf.yaw),
        size: Array.from(record.kf.size),
      },
      frameAttributes: frameAttributes.length > 0 ? frameAttributes : undefined,
    };
  }

  restoreTrack(serialized: SerializedTrack): void {
    validateTrack(serialized);
    this.addTrack(
      { ...serialized.meta, attributes: { ...serialized.meta.attributes } },
      serialized.keyframes,
      serialized.frameAttributes
    );
  }

  // ---- static geometry ----

  addGeometry(meta: GeometryMeta, vertices: number[] | Float32Array): GeometryRecord {
    this.captureGeometry(meta.id);
    validateGeometry({ meta, vertices: Array.from(vertices) });
    const record: GeometryRecord = {
      meta: structuredClone(meta),
      vertices: vertices instanceof Float32Array ? vertices : Float32Array.from(vertices),
    };
    this.geometryMap.set(meta.id, record);
    if (!this.geometryOrder.includes(meta.id)) this.geometryOrder.push(meta.id);
    this.touch(undefined, null);
    return record;
  }

  getGeometry(id: GeometryId): GeometryRecord | undefined {
    return this.geometryMap.get(id);
  }

  listGeometries(): readonly GeometryRecord[] {
    return this.geometryOrder
      .map((id) => this.geometryMap.get(id))
      .filter((r): r is GeometryRecord => !!r);
  }

  get geometryCount(): number {
    return this.geometryMap.size;
  }

  geometriesAt(frame: number): GeometryRecord[] {
    return this.listGeometries().filter(
      (r) => frame >= r.meta.startFrame && frame <= r.meta.endFrame
    );
  }

  setGeometryVertices(id: GeometryId, vertices: number[] | Float32Array): void {
    this.captureGeometry(id);
    const record = this.geometryMap.get(id);
    if (!record) return;
    validateGeometry({ meta: record.meta, vertices: Array.from(vertices) });
    record.vertices =
      vertices instanceof Float32Array ? vertices : Float32Array.from(vertices);
    this.touch(undefined, new Set([id]));
  }

  setGeometryMeta(id: GeometryId, patch: Partial<Omit<GeometryMeta, 'id'>>): void {
    this.captureGeometry(id);
    const record = this.geometryMap.get(id);
    if (!record) return;
    validateGeometry({ meta: { ...record.meta, ...patch }, vertices: Array.from(record.vertices) });
    Object.assign(record.meta, structuredClone(patch));
    this.touch(undefined, new Set([id]));
  }

  deleteGeometry(id: GeometryId): GeometryRecord | undefined {
    this.captureGeometry(id);
    const record = this.geometryMap.get(id);
    if (!record) return undefined;
    this.geometryMap.delete(id);
    this.geometryOrder = this.geometryOrder.filter((g) => g !== id);
    this.touch(undefined, null);
    return record;
  }

  serializeGeometry(id: GeometryId): SerializedGeometry | null {
    const record = this.geometryMap.get(id);
    if (!record) return null;
    return {
      meta: { ...record.meta, attributes: { ...record.meta.attributes } },
      vertices: Array.from(record.vertices),
    };
  }

  restoreGeometry(serialized: SerializedGeometry): void {
    this.addGeometry(
      { ...serialized.meta, attributes: { ...serialized.meta.attributes } },
      serialized.vertices
    );
  }
}

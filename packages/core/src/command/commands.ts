import { normalizeYaw } from '../geometry/math';
import type { TrackStore } from '../model/TrackStore';
import type {
  GeometryId,
  GeometryMeta,
  KeyframeState,
  SerializedGeometry,
  SerializedTrack,
  TrackId,
  TrackMeta,
} from '../model/types';
import { Transaction } from './History';
import type { Command } from './History';

// JSONable keyframe state for payloads / oplog
export interface StateJSON {
  pos: [number, number, number];
  yaw: number;
  size: [number, number, number];
}

export const stateToJSON = (s: KeyframeState): StateJSON => ({
  pos: [s.pos.x, s.pos.y, s.pos.z],
  yaw: s.yaw,
  size: [s.size.x, s.size.y, s.size.z],
});

export const jsonToState = (j: StateJSON): KeyframeState => ({
  pos: { x: j.pos[0], y: j.pos[1], z: j.pos[2] },
  yaw: j.yaw,
  size: { x: j.size[0], y: j.size[1], z: j.size[2] },
});

abstract class StoreCommand implements Command {
  abstract readonly name: string;
  abstract readonly payload: unknown;
  protected applied = false;
  abstract apply(): void;
  abstract undo(): void;
}

export class AddTrackCommand extends StoreCommand {
  readonly name = 'add_track';
  readonly payload: { track: SerializedTrack };
  constructor(private store: TrackStore, track: SerializedTrack) {
    super();
    this.payload = { track };
  }
  apply(): void {
    this.store.restoreTrack((this.payload as { track: SerializedTrack }).track);
    this.applied = true;
  }
  undo(): void {
    if (!this.applied) return;
    this.store.deleteTrack((this.payload as { track: SerializedTrack }).track.meta.id);
    this.applied = false;
  }
}

export class DeleteTracksCommand extends StoreCommand {
  readonly name = 'delete_tracks';
  readonly payload: { ids: TrackId[] };
  private captured: SerializedTrack[] = [];
  constructor(private store: TrackStore, ids: TrackId[]) {
    super();
    this.payload = { ids };
  }
  apply(): void {
    this.captured = (this.payload as { ids: TrackId[] }).ids
      .map((id) => this.store.serializeTrack(id))
      .filter((t): t is SerializedTrack => !!t);
    for (const id of (this.payload as { ids: TrackId[] }).ids) this.store.deleteTrack(id);
    this.applied = true;
  }
  undo(): void {
    if (!this.applied) return;
    for (const track of this.captured) this.store.restoreTrack(track);
    this.captured = [];
    this.applied = false;
  }
}

export class SetKeyframeCommand extends StoreCommand {
  readonly name = 'set_keyframe';
  readonly payload: { id: TrackId; frame: number; state: StateJSON };
  private previous: StateJSON | null = null;
  constructor(private store: TrackStore, id: TrackId, frame: number, state: KeyframeState) {
    super();
    this.payload = { id, frame, state: stateToJSON(state) };
  }
  private get p() {
    return this.payload as { id: TrackId; frame: number; state: StateJSON };
  }
  apply(): void {
    const { id, frame, state } = this.p;
    const existing = this.store.getKeyframes(id);
    if (existing) {
      const idx = existing.frames.indexOf(frame);
      this.previous =
        idx >= 0
          ? stateToJSON({
              pos: { x: existing.pos[idx * 3], y: existing.pos[idx * 3 + 1], z: existing.pos[idx * 3 + 2] },
              yaw: existing.yaw[idx],
              size: { x: existing.size[idx * 3], y: existing.size[idx * 3 + 1], z: existing.size[idx * 3 + 2] },
            })
          : null;
    }
    this.store.setKeyframe(id, frame, jsonToState(state));
    this.applied = true;
  }
  undo(): void {
    if (!this.applied) return;
    const { id, frame } = this.p;
    if (this.previous) this.store.setKeyframe(id, frame, jsonToState(this.previous));
    else this.store.removeKeyframe(id, frame);
    this.applied = false;
  }
}

export class RemoveKeyframeCommand extends StoreCommand {
  readonly name = 'remove_keyframe';
  readonly payload: { id: TrackId; frame: number };
  private previous: StateJSON | null = null;
  constructor(private store: TrackStore, id: TrackId, frame: number) {
    super();
    this.payload = { id, frame };
  }
  apply(): void {
    const { id, frame } = this.payload as { id: TrackId; frame: number };
    const removed = this.store.removeKeyframe(id, frame);
    this.previous = removed ? stateToJSON(removed) : null;
    this.applied = true;
  }
  undo(): void {
    if (!this.applied) return;
    const { id, frame } = this.payload as { id: TrackId; frame: number };
    if (this.previous) this.store.setKeyframe(id, frame, jsonToState(this.previous));
    this.applied = false;
  }
}

export class SetTrackMetaCommand extends StoreCommand {
  readonly name = 'set_track_meta';
  readonly payload: { id: TrackId; patch: Partial<Omit<TrackMeta, 'id'>> };
  private previous: Record<string, unknown> | null = null;
  constructor(private store: TrackStore, id: TrackId, patch: Partial<Omit<TrackMeta, 'id'>>) {
    super();
    this.payload = { id, patch };
  }
  apply(): void {
    const { id, patch } = this.payload as { id: TrackId; patch: Partial<Omit<TrackMeta, 'id'>> };
    const meta = this.store.getTrack(id)?.meta;
    if (!meta) return;
    this.previous = {};
    for (const key of Object.keys(patch) as (keyof TrackMeta)[]) {
      const prev = meta[key];
      this.previous[key] = typeof prev === 'object' ? { ...(prev as object) } : prev;
    }
    this.store.setTrackMeta(id, patch);
    this.applied = true;
  }
  undo(): void {
    if (!this.applied || !this.previous) return;
    const { id } = this.payload as { id: TrackId };
    this.store.setTrackMeta(id, this.previous as Partial<Omit<TrackMeta, 'id'>>);
    this.previous = null;
    this.applied = false;
  }
}

export class SetFrameAttributeCommand extends StoreCommand {
  readonly name = 'set_frame_attribute';
  readonly payload: { id: TrackId; frame: number; key: string; value: string | number | boolean | null };
  private previous: string | number | boolean | null = null;
  constructor(
    private store: TrackStore,
    id: TrackId,
    frame: number,
    key: string,
    value: string | number | boolean | null
  ) {
    super();
    this.payload = { id, frame, key, value };
  }
  apply(): void {
    const { id, frame, key } = this.payload as { id: TrackId; frame: number; key: string };
    const attrs = this.store.getFrameAttributes(id, frame);
    this.previous = attrs && key in attrs ? attrs[key] : null;
    this.store.setFrameAttribute(id, frame, key, this.value());
    this.applied = true;
  }
  private value(): string | number | boolean | null {
    return (this.payload as { value: string | number | boolean | null }).value;
  }
  undo(): void {
    if (!this.applied) return;
    const { id, frame, key } = this.payload as { id: TrackId; frame: number; key: string };
    this.store.setFrameAttribute(id, frame, key, this.previous);
    this.applied = false;
  }
}

export interface TransformDelta {
  dx: number;
  dy: number;
  dz: number;
  dyaw: number;
}

/** Transforms keyframes within [fromFrame, toFrame] by a rigid delta. */
export class TransformTracksCommand extends StoreCommand {
  readonly name = 'transform_tracks';
  readonly payload: { ids: TrackId[]; fromFrame: number; toFrame: number; delta: TransformDelta };
  private captured: Array<{ id: TrackId; frame: number; state: StateJSON }> = [];
  constructor(
    private store: TrackStore,
    ids: TrackId[],
    fromFrame: number,
    toFrame: number,
    delta: TransformDelta
  ) {
    super();
    this.payload = { ids, fromFrame, toFrame, delta };
  }
  apply(): void {
    const { ids, fromFrame, toFrame, delta } = this.payload as {
      ids: TrackId[];
      fromFrame: number;
      toFrame: number;
      delta: TransformDelta;
    };
    this.captured = [];
    for (const id of ids) {
      const kf = this.store.getKeyframes(id);
      if (!kf) continue;
      for (let i = 0; i < kf.frames.length; i++) {
        const frame = kf.frames[i];
        if (frame < fromFrame || frame > toFrame) continue;
        const state: KeyframeState = {
          pos: { x: kf.pos[i * 3], y: kf.pos[i * 3 + 1], z: kf.pos[i * 3 + 2] },
          yaw: kf.yaw[i],
          size: { x: kf.size[i * 3], y: kf.size[i * 3 + 1], z: kf.size[i * 3 + 2] },
        };
        this.captured.push({ id, frame, state: stateToJSON(state) });
        this.store.setKeyframe(id, frame, {
          pos: { x: state.pos.x + delta.dx, y: state.pos.y + delta.dy, z: state.pos.z + delta.dz },
          yaw: normalizeYaw(state.yaw + delta.dyaw),
          size: state.size,
        });
      }
    }
    this.applied = true;
  }
  undo(): void {
    if (!this.applied) return;
    for (const cap of this.captured) this.store.setKeyframe(cap.id, cap.frame, jsonToState(cap.state));
    this.captured = [];
    this.applied = false;
  }
}

/** Splits a track at `frame`; keyframes >= frame move to newId. */
export class SplitTrackCommand extends StoreCommand {
  readonly name = 'split_track';
  readonly payload: { id: TrackId; frame: number; newId: TrackId };
  private original: SerializedTrack | null = null;
  constructor(private store: TrackStore, id: TrackId, frame: number, newId: TrackId) {
    super();
    this.payload = { id, frame, newId };
  }
  apply(): void {
    const { id, frame, newId } = this.payload as { id: TrackId; frame: number; newId: TrackId };
    const original = this.store.serializeTrack(id);
    if (!original) return;
    this.original = original;
    const head: SerializedTrack = {
      meta: { ...original.meta, endFrame: frame - 1 },
      keyframes: {
        frames: [],
        pos: [],
        yaw: [],
        size: [],
      },
      frameAttributes: original.frameAttributes?.filter((f) => f.frame < frame),
    };
    const tail: SerializedTrack = {
      meta: { ...original.meta, id: newId, startFrame: frame },
      keyframes: { frames: [], pos: [], yaw: [], size: [] },
      frameAttributes: original.frameAttributes?.filter((f) => f.frame >= frame),
    };
    for (let i = 0; i < original.keyframes.frames.length; i++) {
      const f = original.keyframes.frames[i];
      const target = f >= frame ? tail : head;
      target.keyframes.frames.push(f);
      target.keyframes.pos.push(
        original.keyframes.pos[i * 3],
        original.keyframes.pos[i * 3 + 1],
        original.keyframes.pos[i * 3 + 2]
      );
      target.keyframes.yaw.push(original.keyframes.yaw[i]);
      target.keyframes.size.push(
        original.keyframes.size[i * 3],
        original.keyframes.size[i * 3 + 1],
        original.keyframes.size[i * 3 + 2]
      );
    }
    this.store.restoreTrack(head);
    if (tail.keyframes.frames.length > 0) this.store.restoreTrack(tail);
    else this.store.setTrackMeta(id, { endFrame: frame - 1 });
    this.applied = true;
  }
  undo(): void {
    if (!this.applied || !this.original) return;
    const { id, newId } = this.payload as { id: TrackId; newId: TrackId };
    this.store.deleteTrack(newId);
    this.store.deleteTrack(id);
    this.store.restoreTrack(this.original);
    this.original = null;
    this.applied = false;
  }
}

export class MergeTracksCommand extends StoreCommand {
  readonly name = 'merge_tracks';
  readonly payload: { idA: TrackId; idB: TrackId };
  private capturedA: SerializedTrack | null = null;
  private capturedB: SerializedTrack | null = null;
  constructor(private store: TrackStore, idA: TrackId, idB: TrackId) {
    super();
    this.payload = { idA, idB };
  }
  apply(): void {
    const { idA, idB } = this.payload as { idA: TrackId; idB: TrackId };
    const a = this.store.serializeTrack(idA);
    const b = this.store.serializeTrack(idB);
    if (!a || !b) return;
    this.capturedA = a;
    this.capturedB = b;
    const merged: SerializedTrack = {
      meta: {
        ...a.meta,
        startFrame: Math.min(a.meta.startFrame, b.meta.startFrame),
        endFrame: Math.max(a.meta.endFrame, b.meta.endFrame),
      },
      keyframes: {
        frames: [...a.keyframes.frames],
        pos: [...a.keyframes.pos],
        yaw: [...a.keyframes.yaw],
        size: [...a.keyframes.size],
      },
      frameAttributes: [...(a.frameAttributes ?? []), ...(b.frameAttributes ?? [])],
    };
    for (let i = 0; i < b.keyframes.frames.length; i++) {
      const frame = b.keyframes.frames[i];
      if (merged.keyframes.frames.includes(frame)) continue; // A wins on collision
      merged.keyframes.frames.push(frame);
      merged.keyframes.pos.push(
        b.keyframes.pos[i * 3],
        b.keyframes.pos[i * 3 + 1],
        b.keyframes.pos[i * 3 + 2]
      );
      merged.keyframes.yaw.push(b.keyframes.yaw[i]);
      merged.keyframes.size.push(
        b.keyframes.size[i * 3],
        b.keyframes.size[i * 3 + 1],
        b.keyframes.size[i * 3 + 2]
      );
    }
    this.store.deleteTrack(idB);
    this.store.deleteTrack(idA);
    this.store.restoreTrack(merged);
    this.applied = true;
  }
  undo(): void {
    if (!this.applied || !this.capturedA || !this.capturedB) return;
    const { idA, idB } = this.payload as { idA: TrackId; idB: TrackId };
    this.store.deleteTrack(idA);
    this.store.restoreTrack(this.capturedA);
    this.store.restoreTrack(this.capturedB);
    this.capturedA = null;
    this.capturedB = null;
    this.applied = false;
  }
}

export class AddGeometryCommand extends StoreCommand {
  readonly name = 'add_geometry';
  readonly payload: { geometry: SerializedGeometry };
  constructor(private store: TrackStore, geometry: SerializedGeometry) {
    super();
    this.payload = { geometry };
  }
  apply(): void {
    this.store.restoreGeometry((this.payload as { geometry: SerializedGeometry }).geometry);
    this.applied = true;
  }
  undo(): void {
    if (!this.applied) return;
    this.store.deleteGeometry((this.payload as { geometry: SerializedGeometry }).geometry.meta.id);
    this.applied = false;
  }
}

export class UpdateGeometryCommand extends StoreCommand {
  readonly name = 'update_geometry';
  readonly payload: { id: GeometryId; vertices: number[]; metaPatch?: Partial<Omit<GeometryMeta, 'id'>> };
  private previousVertices: number[] | null = null;
  private previousMeta: Record<string, unknown> | null = null;
  constructor(
    private store: TrackStore,
    id: GeometryId,
    vertices?: number[],
    metaPatch?: Partial<Omit<GeometryMeta, 'id'>>
  ) {
    super();
    this.payload = { id, vertices: vertices ?? [], metaPatch };
  }
  apply(): void {
    const { id, vertices, metaPatch } = this.payload as {
      id: GeometryId;
      vertices: number[];
      metaPatch?: Partial<Omit<GeometryMeta, 'id'>>;
    };
    const record = this.store.getGeometry(id);
    if (!record) return;
    if (vertices.length > 0) {
      this.previousVertices = Array.from(record.vertices);
      this.store.setGeometryVertices(id, vertices);
    }
    if (metaPatch) {
      this.previousMeta = {};
      for (const key of Object.keys(metaPatch) as (keyof GeometryMeta)[]) {
        const prev = record.meta[key];
        this.previousMeta[key] = typeof prev === 'object' ? { ...(prev as object) } : prev;
      }
      this.store.setGeometryMeta(id, metaPatch);
    }
    this.applied = true;
  }
  undo(): void {
    if (!this.applied) return;
    const { id } = this.payload as { id: GeometryId };
    if (this.previousVertices) this.store.setGeometryVertices(id, this.previousVertices);
    if (this.previousMeta) this.store.setGeometryMeta(id, this.previousMeta as Partial<GeometryMeta>);
    this.previousVertices = null;
    this.previousMeta = null;
    this.applied = false;
  }
}

export class DeleteGeometryCommand extends StoreCommand {
  readonly name = 'delete_geometry';
  readonly payload: { id: GeometryId };
  private captured: SerializedGeometry | null = null;
  constructor(private store: TrackStore, id: GeometryId) {
    super();
    this.payload = { id };
  }
  apply(): void {
    const captured = this.store.serializeGeometry((this.payload as { id: GeometryId }).id);
    if (!captured) return;
    this.captured = captured;
    this.store.deleteGeometry((this.payload as { id: GeometryId }).id);
    this.applied = true;
  }
  undo(): void {
    if (!this.applied || !this.captured) return;
    this.store.restoreGeometry(this.captured);
    this.captured = null;
    this.applied = false;
  }
}

type PayloadOf<C> = C extends { payload: infer P } ? P : never;
type AnyCommand =
  | AddTrackCommand
  | DeleteTracksCommand
  | SetKeyframeCommand
  | RemoveKeyframeCommand
  | SetTrackMetaCommand
  | SetFrameAttributeCommand
  | TransformTracksCommand
  | SplitTrackCommand
  | MergeTracksCommand
  | AddGeometryCommand
  | UpdateGeometryCommand
  | DeleteGeometryCommand;

/** Oplog replay: rebuild commands from recorded names + payloads. */
export function createCommand(
  store: TrackStore,
  name: string,
  payload: PayloadOf<AnyCommand> | { children: Array<{ name: string; payload: unknown }> }
): Command {
  switch (name) {
    case 'batch': {
      const p = payload as { children: Array<{ name: string; payload: unknown }> };
      return new Transaction(
        p.children.map((child) => createCommand(store, child.name, child.payload as PayloadOf<AnyCommand>))
      );
    }
    case 'add_track':
      return new AddTrackCommand(store, (payload as PayloadOf<AddTrackCommand>).track);
    case 'delete_tracks':
      return new DeleteTracksCommand(store, (payload as PayloadOf<DeleteTracksCommand>).ids);
    case 'set_keyframe':
      return new SetKeyframeCommand(
        store,
        (payload as PayloadOf<SetKeyframeCommand>).id,
        (payload as PayloadOf<SetKeyframeCommand>).frame,
        jsonToState((payload as PayloadOf<SetKeyframeCommand>).state)
      );
    case 'remove_keyframe':
      return new RemoveKeyframeCommand(
        store,
        (payload as PayloadOf<RemoveKeyframeCommand>).id,
        (payload as PayloadOf<RemoveKeyframeCommand>).frame
      );
    case 'set_track_meta':
      return new SetTrackMetaCommand(
        store,
        (payload as PayloadOf<SetTrackMetaCommand>).id,
        (payload as PayloadOf<SetTrackMetaCommand>).patch
      );
    case 'set_frame_attribute':
      return new SetFrameAttributeCommand(
        store,
        (payload as PayloadOf<SetFrameAttributeCommand>).id,
        (payload as PayloadOf<SetFrameAttributeCommand>).frame,
        (payload as PayloadOf<SetFrameAttributeCommand>).key,
        (payload as PayloadOf<SetFrameAttributeCommand>).value
      );
    case 'transform_tracks': {
      const p = payload as PayloadOf<TransformTracksCommand>;
      return new TransformTracksCommand(store, p.ids, p.fromFrame, p.toFrame, p.delta);
    }
    case 'split_track': {
      const p = payload as PayloadOf<SplitTrackCommand>;
      return new SplitTrackCommand(store, p.id, p.frame, p.newId);
    }
    case 'merge_tracks': {
      const p = payload as PayloadOf<MergeTracksCommand>;
      return new MergeTracksCommand(store, p.idA, p.idB);
    }
    case 'add_geometry':
      return new AddGeometryCommand(store, (payload as PayloadOf<AddGeometryCommand>).geometry);
    case 'update_geometry': {
      const p = payload as PayloadOf<UpdateGeometryCommand>;
      return new UpdateGeometryCommand(store, p.id, p.vertices, p.metaPatch);
    }
    case 'delete_geometry':
      return new DeleteGeometryCommand(store, (payload as PayloadOf<DeleteGeometryCommand>).id);
    default:
      throw new Error(`Unknown command: ${name}`);
  }
}

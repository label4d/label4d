import { EventEmitter } from '../events/EventEmitter';
import { History, OpLog } from '../command/History';
import type { Command } from '../command/History';
import {
  AddGeometryCommand,
  AddTrackCommand,
  createCommand,
  DeleteGeometryCommand,
  DeleteTracksCommand,
  RemoveKeyframeCommand,
  SetFrameAttributeCommand,
  SetKeyframeCommand,
  SetTrackMetaCommand,
  SplitTrackCommand,
  TransformTracksCommand,
  UpdateGeometryCommand,
  MergeTracksCommand,
} from '../command/commands';
import { TrackStore } from '../model/TrackStore';
import type { StoreChange } from '../model/TrackStore';
import { SelectionSet } from '../model/SelectionSet';
import { DEFAULT_LABELS } from '../model/types';
import type { GeometryKind, KeyframeState, LabelDef, SerializedTrack, TrackId } from '../model/types';
import { vec3 } from '../geometry/math';
import type { Vec3 } from '../geometry/math';
import { Playhead } from '../playback/Playhead';
import type { RafFn, CancelRafFn } from '../playback/Playhead';
import { EgoTrack, CameraProjector } from '../projection/projection';
import type { ToolIntent, ToolId } from '../interaction/ToolMachine';
import { ToolMachine } from '../interaction/ToolMachine';
import { TileScheduler } from '../stream/TileScheduler';
import { FrameBuffer } from '../stream/FrameBuffer';
import { BevPyramid } from '../stream/BevPyramid';
import { HeightField } from '../stream/HeightField';
import type { ImageFetcher, ImageDecoder } from '../stream/HeightField';
import { PotreeOverlay, potreeUncompressedDecoder } from '../stream/PotreeOverlay';
import type { PotreeDecoder, NetClient } from '../stream/PotreeOverlay';
import { parsePcd } from '../io/pcd';
import type { PointCloudFrame } from '../io/pcd';
import { substituteFrame } from '../io/manifest';
import type { SequenceManifest, TilesetConfig } from '../io/manifest';
import { applySnapshot, serializeStore } from '../io/snapshot';
import type { SnapshotDocument, SnapshotQA } from '../io/snapshot';
import { exportNuScenesAnnotations } from '../io/formats';
import type { NuScenesExportOptions } from '../io/formats';
import { applyCandidates } from '../assist/AssistAdapter';
import type { AssistAdapter } from '../assist/AssistAdapter';

export interface SessionEvents {
  frameChanged: { frame: number };
  manifestLoaded: { manifest: SequenceManifest };
  storeChanged: StoreChange;
  selectionChanged: { version: number };
  historyChanged: { canUndo: boolean; canRedo: boolean };
  hoverChanged: { id: string | null };
  toolChanged: { tool: ToolId };
  labelsChanged: { hidden: string[] };
  blinkChanged: { label: string | null; on: boolean };
  measurement: { kind: 'distance' | 'height' | 'angle'; value: number; points: Vec3[] } | null;
  error: { message: string };
}

export interface SessionDeps {
  raf?: RafFn;
  cancelRaf?: CancelRafFn;
  fetchImage?: ImageFetcher;
  decodeImage?: ImageDecoder;
  net?: NetClient;
  potreeDecoder?: PotreeDecoder;
  schedulerBudgetBytes?: number;
  pointCloudWindow?: { ahead: number; behind: number; budgetBytes: number };
}

const defaultDecodeImage: ImageDecoder = (image) => {
  const w = 'width' in image ? image.width : 0;
  const h = 'height' in image ? image.height : 0;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image as CanvasImageSource, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h);
  return { data: rgba.data, width: w, height: h };
};

const defaultFetchImage: ImageFetcher = async (url) => {
  const response = await fetch(url);
  const blob = await response.blob();
  return createImageBitmap(blob, { imageOrientation: 'flipY' });
};

const defaultNet: NetClient = {
  fetchJson: (url) => fetch(url).then((r) => r.json()),
  fetchBinary: (url, init) => fetch(url, init).then((r) => r.arrayBuffer()),
};

/**
 * Composition root — the only object UI code talks to. Owns the document
 * (store/history/oplog), the playhead, streaming resources, and the tool
 * state machine; turns intents into commands.
 */
export class EditorSession {
  readonly store = new TrackStore();
  readonly selection = new SelectionSet();
  readonly history = new History();
  readonly oplog = new OpLog();
  readonly tools = new ToolMachine();
  readonly playhead: Playhead;
  readonly scheduler: TileScheduler;
  readonly events = new EventEmitter<SessionEvents>();

  manifest: SequenceManifest | null = null;
  labels: LabelDef[] = DEFAULT_LABELS;
  ego: EgoTrack = EgoTrack.identity(1);
  projectors = new Map<string, CameraProjector>();
  pcdFrames: FrameBuffer<PointCloudFrame> | null = null;
  imageFrames: FrameBuffer<ImageBitmap | HTMLImageElement> | null = null;
  bevPyramid: BevPyramid | null = null;
  heightField: HeightField | null = null;
  potree: PotreeOverlay | null = null;
  activeCameraId: string | null = null;
  hover: string | null = null;
  activeLabel = 'Car';
  activeGeometryKind: GeometryKind = 'lane';
  qa: SnapshotQA = { status: 'pending', notes: '' };

  /** per-class view visibility (annotation filter) */
  hiddenLabels = new Set<string>();
  /** configurable blink highlight: tracks of this label flash in all views */
  blinkLabel: string | null = null;
  blinkOn = false;
  lastMeasurement: { kind: 'distance' | 'height' | 'angle'; value: number; points: Vec3[] } | null = null;

  private blinkTimer: ReturnType<typeof setInterval> | null = null;

  /** Rect-in-screen-space query, registered by the BEV view for marquee select. */
  rectPicker: ((rect: { x0: number; y0: number; x1: number; y1: number }) => string[]) | null = null;

  private evictHandlers = new Map<string, (id: string, resource: unknown) => void>();
  private readonly deps: SessionDeps;

  constructor(deps: SessionDeps = {}) {
    this.deps = deps;
    this.playhead = new Playhead(1, deps.raf, deps.cancelRaf);
    this.scheduler = new TileScheduler({
      concurrency: 6,
      budgetBytes: deps.schedulerBudgetBytes ?? 1.5 * 1024 * 1024 * 1024,
      onEvict: (id, resource) => {
        for (const [prefix, handler] of this.evictHandlers) {
          if (id.startsWith(prefix)) handler(id, resource);
        }
      },
    });
    this.oplog.snapshotProvider = () => this.exportSnapshot();

    this.history.setRecorder((cmd) => {
      this.flattenToOplog(cmd);
    });
    this.history.events.on('changed', ({ canUndo, canRedo }) => {
      this.events.emit('historyChanged', { canUndo, canRedo });
    });
    this.store.events.on('changed', (change) => {
      this.events.emit('storeChanged', change);
    });
    this.selection.events.on('changed', ({ version }) => {
      this.events.emit('selectionChanged', { version });
    });
    this.tools.events.on('changed', ({ tool }) => {
      this.events.emit('toolChanged', { tool });
    });
    this.playhead.events.on('frame', ({ frame }) => {
      this.syncFrameResources(frame);
      this.events.emit('frameChanged', { frame });
    });
  }

  private flattenToOplog(cmd: Command): void {
    if (cmd.name === 'batch') {
      const payload = cmd.payload as { children: Array<{ name: string; payload: unknown }> };
      for (const child of payload.children) {
        this.oplog.record(child.name, child.payload);
      }
    } else {
      this.oplog.record(cmd.name, cmd.payload);
    }
  }

  registerEvictHandler(prefix: string, handler: (id: string, resource: unknown) => void): void {
    this.evictHandlers.set(prefix, handler);
  }

  get frame(): number {
    return this.playhead.frame;
  }

  get frameCount(): number {
    return this.manifest?.frameCount ?? 1;
  }

  // ---- manifest / resources ----

  async loadManifest(manifest: SequenceManifest): Promise<void> {
    this.manifest = manifest;
    this.labels = manifest.labels && manifest.labels.length > 0 ? manifest.labels : DEFAULT_LABELS;
    this.playhead.fps = manifest.fps > 0 ? manifest.fps : 10;
    this.playhead.setFrameCount(manifest.frameCount);
    this.playhead.setFrame(0);

    if (typeof manifest.egoPoses === 'string') {
      try {
        const data = await (this.deps.net ?? defaultNet).fetchJson(manifest.egoPoses);
        const poses = data && typeof data === 'object' && Array.isArray((data as { poses?: number[][] }).poses)
          ? (data as { poses: number[][] }).poses
          : data;
        this.ego = new EgoTrack(parseEgoArray(poses, manifest.frameCount) ?? new Float64Array(0), manifest.frameCount);
      } catch (error) {
        this.ego = EgoTrack.identity(manifest.frameCount);
      }
    } else if (manifest.egoPoses) {
      const parsed = parseEgoArray(manifest.egoPoses, manifest.frameCount);
      this.ego = parsed ? new EgoTrack(parsed, manifest.frameCount) : EgoTrack.identity(manifest.frameCount);
    } else {
      this.ego = EgoTrack.identity(manifest.frameCount);
    }

    this.projectors.clear();
    for (const camera of manifest.cameras ?? []) {
      this.projectors.set(camera.id, CameraProjector.create(camera, this.ego));
    }
    this.activeCameraId = manifest.cameras?.[0]?.id ?? null;

    if (manifest.pointCloud) {
      this.pcdFrames = new FrameBuffer<PointCloudFrame>(
        {
          load: async (frame) =>
            parsePcd(await (this.deps.net ?? defaultNet).fetchBinary(substituteFrame(manifest.pointCloud!.urlTemplate, frame))),
          bytes: (item) =>
            item.positions.byteLength + (item.intensity?.byteLength ?? 0) + (item.rgb?.byteLength ?? 0),
          dispose: () => undefined, // arrays are GC-managed; GPU wrappers disposed by the view
        },
        this.scheduler,
        {
          windowAhead: this.deps.pointCloudWindow?.ahead ?? 45,
          windowBehind: this.deps.pointCloudWindow?.behind ?? 45,
          budgetBytes: this.deps.pointCloudWindow?.budgetBytes ?? 512 * 1024 * 1024,
          idPrefix: 'pcd',
          frameCount: manifest.frameCount,
        }
      );
    } else {
      this.pcdFrames = null;
    }

    if (manifest.cameras?.length) {
      const camera = manifest.cameras[0];
      this.imageFrames = new FrameBuffer<ImageBitmap | HTMLImageElement>(
        {
          load: async (frame) => (this.deps.fetchImage ?? defaultFetchImage)(substituteFrame(camera.imageTemplate, frame)),
          bytes: (image) => ('width' in image ? image.width * image.height * 4 : 0),
          dispose: () => undefined,
        },
        this.scheduler,
        { windowAhead: 4, windowBehind: 2, budgetBytes: 256 * 1024 * 1024, idPrefix: 'img', frameCount: manifest.frameCount }
      );
    } else {
      this.imageFrames = null;
    }

    if (manifest.bev?.tileset) {
      this.bevPyramid = new BevPyramid(manifest.bev.tileset);
    } else {
      this.bevPyramid = null;
    }

    if (manifest.height) {
      // 单图模式: height.url + extent；瓦片模式: height.tileset
      const h = manifest.height;
      let config: TilesetConfig | undefined = h.tileset;
      if (!config && h.url && h.width && h.height) {
        config = {
          originX: h.originX ?? 0,
          originZ: h.originZ ?? 0,
          metersPerPixel: h.metersPerPixel ?? 1,
          width: h.width,
          height: h.height,
          tileSize: Math.max(h.width, h.height),
          urlTemplate: h.url,
        };
      }
      if (config) {
        this.heightField = new HeightField(
          config,
          this.scheduler,
          this.deps.fetchImage ?? defaultFetchImage,
          this.deps.decodeImage ?? defaultDecodeImage
        );
      } else {
        this.heightField = null;
      }
    } else {
      this.heightField = null;
    }

    if (manifest.potree) {
      this.potree = new PotreeOverlay(
        manifest.potree.url,
        this.scheduler,
        this.deps.potreeDecoder ?? potreeUncompressedDecoder,
        this.deps.net ?? defaultNet
      );
      this.potree.initialize().catch(() => {
        this.events.emit('error', { message: 'Potree overlay failed to initialize' });
      });
    } else {
      this.potree = null;
    }

    this.events.emit('manifestLoaded', { manifest });
    this.syncFrameResources(0);
    this.events.emit('frameChanged', { frame: 0 });
  }

  // ---- frame / playback ----

  setFrame(frame: number): void {
    this.playhead.setFrame(frame);
  }

  play(): void {
    this.playhead.play();
  }

  pause(): void {
    this.playhead.pause();
  }

  private syncFrameResources(frame: number): void {
    this.pcdFrames?.setFrame(frame);
    this.imageFrames?.setFrame(frame);
  }

  currentPointCloud(): PointCloudFrame | null {
    return this.pcdFrames?.get(this.frame) ?? null;
  }

  currentCameraImage(): ImageBitmap | HTMLImageElement | null {
    return this.imageFrames?.get(this.frame) ?? null;
  }

  // ---- intents -> commands ----

  applyIntent(intent: ToolIntent): void {
    switch (intent.type) {
      case 'select': {
        this.selection.select(intent.ids, intent.mode);
        break;
      }
      case 'selectRect': {
        const ids = this.rectPicker?.(intent.rect) ?? [];
        this.selection.select(ids, intent.mode);
        break;
      }
      case 'createBox': {
        this.pause();
        const label = this.labels.find((l) => l.name === this.activeLabel) ?? this.labels[0];
        const size = vec3(
          intent.length,
          label?.defaultSize?.[1] ?? 1.5,
          intent.width
        );
        const pos = vec3(intent.center.x, this.sampleHeight(intent.center.x, intent.center.z) + size.y / 2, intent.center.z);
        const frame = this.frame;
        const id = this.store.nextTrackId();
        const track: SerializedTrack = {
          meta: {
            id,
            label: this.activeLabel,
            startFrame: frame,
            endFrame: frame,
            interpolation: 'linear',
            source: 'human',
            attributes: {},
          },
          keyframes: {
            frames: [frame],
            pos: [pos.x, pos.y, pos.z],
            yaw: [intent.yaw],
            size: [size.x, size.y, size.z],
          },
        };
        this.history.push(new AddTrackCommand(this.store, track));
        this.selection.select([id]);
        break;
      }
      case 'createGeometry': {
        this.pause();
        const vertices: number[] = [];
        for (const vertex of intent.vertices) {
          vertices.push(vertex.x, this.sampleHeight(vertex.x, vertex.z), vertex.z);
        }
        const id = this.store.nextGeometryId();
        this.history.push(
          new AddGeometryCommand(this.store, {
            meta: {
              id,
              kind: this.activeGeometryKind,
              label: this.activeGeometryKind === 'crosswalk' || this.activeGeometryKind === 'zone' ? this.activeGeometryKind : 'Lane',
              closed: intent.closed,
              startFrame: 0,
              endFrame: Math.max(0, this.frameCount - 1),
              attributes: {},
            },
            vertices,
          })
        );
        this.selection.select([id]);
        break;
      }
      case 'moveGeometryVertex': {
        this.pause();
        const record = this.store.getGeometry(intent.id);
        if (!record) break;
        const vertices = Array.from(record.vertices);
        vertices[intent.index * 3] = intent.pos.x;
        vertices[intent.index * 3 + 1] = intent.pos.y || this.sampleHeight(intent.pos.x, intent.pos.z);
        vertices[intent.index * 3 + 2] = intent.pos.z;
        this.history.push(new UpdateGeometryCommand(this.store, intent.id, vertices));
        break;
      }
      case 'deleteGeometryVertex': {
        this.pause();
        const record = this.store.getGeometry(intent.id);
        if (!record) break;
        const n = record.vertices.length / 3;
        if (n <= 2) break; // keep at least a segment
        const vertices: number[] = [];
        for (let i = 0; i < n; i++) {
          if (i === intent.index) continue;
          vertices.push(record.vertices[i * 3], record.vertices[i * 3 + 1], record.vertices[i * 3 + 2]);
        }
        this.history.push(new UpdateGeometryCommand(this.store, intent.id, vertices));
        break;
      }
      case 'moveSelection': {
        this.pause();
        const delta = intent.delta;
        const trackIds: string[] = [];
        const geometryIds: string[] = [];
        for (const id of this.selection.all()) {
          if (this.store.getTrack(id)) trackIds.push(id);
          else if (this.store.getGeometry(id)) geometryIds.push(id);
        }
        const commands: Command[] = [];
        if (trackIds.length > 0) {
          commands.push(new TransformTracksCommand(this.store, trackIds, 0, Number.MAX_SAFE_INTEGER, { dx: delta.x, dy: delta.y, dz: delta.z, dyaw: 0 }));
        }
        for (const id of geometryIds) {
          const record = this.store.getGeometry(id);
          if (!record) continue;
          const vertices = Array.from(record.vertices);
          for (let i = 0; i < vertices.length; i += 3) {
            vertices[i] += delta.x;
            vertices[i + 1] += delta.y;
            vertices[i + 2] += delta.z;
          }
          commands.push(new UpdateGeometryCommand(this.store, id, vertices));
        }
        if (commands.length === 1) this.history.push(commands[0]);
        else if (commands.length > 1) this.history.pushTransaction(commands);
        break;
      }
      case 'rotateSelection': {
        this.pause();
        const ids: string[] = [];
        for (const id of this.selection.all()) if (this.store.getTrack(id)) ids.push(id);
        if (ids.length > 0) {
          this.history.push(
            new TransformTracksCommand(this.store, ids, 0, Number.MAX_SAFE_INTEGER, { dx: 0, dy: 0, dz: 0, dyaw: intent.dyaw })
          );
        }
        break;
      }
      case 'measureDone': {
        const value = ToolMachine.measureValue(intent.kind, intent.points);
        this.lastMeasurement = value !== null ? { kind: intent.kind, value, points: intent.points } : null;
        this.events.emit('measurement', this.lastMeasurement);
        break;
      }
      case 'none':
      default:
        break;
    }
  }

  setTool(tool: ToolId): void {
    this.tools.setTool(tool);
  }

  // ---- track/geometry editing API (panels) ----

  setKeyframeAtCurrentFrame(id: TrackId): void {
    this.pause();
    const state = this.store.resolveState(id, this.frame);
    if (!state) return;
    this.history.push(new SetKeyframeCommand(this.store, id, this.frame, state as KeyframeState));
  }

  removeKeyframeAtCurrentFrame(id: TrackId): void {
    this.pause();
    this.history.push(new RemoveKeyframeCommand(this.store, id, this.frame));
  }

  copyStateToFrame(id: TrackId, toFrame: number): void {
    this.pause();
    const state = this.store.resolveState(id, this.frame);
    if (!state) return;
    this.history.push(new SetKeyframeCommand(this.store, id, toFrame, state as KeyframeState));
  }

  deleteSelection(): void {
    this.pause();
    const trackIds: string[] = [];
    const geometryIds: string[] = [];
    for (const id of this.selection.all()) {
      if (this.store.getTrack(id)) trackIds.push(id);
      else if (this.store.getGeometry(id)) geometryIds.push(id);
    }
    const commands: Command[] = [];
    if (trackIds.length > 0) commands.push(new DeleteTracksCommand(this.store, trackIds));
    for (const id of geometryIds) commands.push(new DeleteGeometryCommand(this.store, id));
    if (commands.length === 0) return;
    if (commands.length === 1) this.history.push(commands[0]);
    else this.history.pushTransaction(commands);
    this.selection.clear();
  }

  splitSelectedAtCurrentFrame(): void {
    const id = this.selection.first;
    if (!id || !this.store.getTrack(id)) return;
    this.pause();
    this.history.push(new SplitTrackCommand(this.store, id, this.frame, this.store.nextTrackId()));
  }

  mergeSelectedTracks(): void {
    const ids = this.selection.all().filter((id) => this.store.getTrack(id));
    if (ids.length < 2) return;
    this.pause();
    let primary = ids[0];
    const commands: Command[] = [];
    for (let i = 1; i < ids.length; i++) {
      commands.push(new MergeTracksCommand(this.store, primary, ids[i]));
      // after merge, primary persists
    }
    if (commands.length === 1) this.history.push(commands[0]);
    else this.history.pushTransaction(commands);
  }

  setTrackAttribute(id: TrackId, key: string, value: string | number | boolean): void {
    const record = this.store.getTrack(id);
    if (!record) return;
    this.history.push(
      new SetTrackMetaCommand(this.store, id, { attributes: { ...record.meta.attributes, [key]: value } })
    );
  }

  setFrameAttribute(id: TrackId, key: string, value: string | number | boolean | null): void {
    this.history.push(new SetFrameAttributeCommand(this.store, id, this.frame, key, value));
  }

  // ---- picking helpers ----

  /** Nearest track box hit by a world-space ray (origin + direction). */
  pickTrackByRay(origin: Vec3, dir: Vec3, frame: number): { id: string; t: number } | null {
    let best: { id: string; t: number } | null = null;
    for (const id of this.store.activeTrackIds(frame)) {
      const state = this.store.resolveState(id, frame);
      if (!state) continue;
      const t = rayOBBT(origin, dir, state.pos, state.yaw, state.size);
      if (t !== null && (!best || t < best.t)) best = { id, t };
    }
    return best;
  }

  /** Nearest geometry polyline within tolerance of a ground point. */
  pickGeometryAtWorld(world: Vec3, tolerance: number): string | null {
    let best: string | null = null;
    let bestDist = tolerance;
    for (const geom of this.store.geometriesAt(this.frame)) {
      const n = geom.vertices.length / 3;
      for (let i = 0; i < n; i++) {
        const dist = Math.hypot(world.x - geom.vertices[i * 3], world.z - geom.vertices[i * 3 + 2]);
        if (dist < bestDist) {
          bestDist = dist;
          best = geom.meta.id;
        }
      }
    }
    return best;
  }

  setHover(id: string | null): void {
    if (id === this.hover) return;
    this.hover = id;
    this.events.emit('hoverChanged', { id });
  }

  /** Per-class visibility filter — views stop rendering hidden classes. */
  setLabelHidden(label: string, hidden: boolean): void {
    if (hidden) this.hiddenLabels.add(label);
    else this.hiddenLabels.delete(label);
    this.events.emit('labelsChanged', { hidden: [...this.hiddenLabels] });
  }

  showAllLabels(): void {
    if (this.hiddenLabels.size === 0) return;
    this.hiddenLabels.clear();
    this.events.emit('labelsChanged', { hidden: [] });
  }

  /** Configurable blink highlight for a label class (null = off). */
  setBlinkLabel(label: string | null): void {
    this.blinkLabel = label;
    this.blinkOn = false;
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    if (label) {
      this.blinkTimer = setInterval(() => {
        this.blinkOn = !this.blinkOn;
        this.events.emit('blinkChanged', { label: this.blinkLabel, on: this.blinkOn });
      }, 400);
    }
    this.events.emit('blinkChanged', { label, on: false });
  }

  sampleHeight(x: number, z: number): number {
    return this.heightField?.sampleSync(x, z) ?? 0;
  }

  /** Arrow-key nudge of the selection (tracks + geometry), one undo step. */
  nudgeSelection(delta: Vec3): void {
    if (this.selection.size === 0) return;
    this.applyIntent({ type: 'moveSelection', delta });
  }

  /** Duplicate selected tracks with a lateral offset, selecting the copies. */
  duplicateSelection(offset: Vec3 = vec3(2, 0, 2)): void {
    const ids = this.selection.all().filter((id) => this.store.getTrack(id));
    if (ids.length === 0) return;
    this.pause();
    const commands: Command[] = [];
    const newIds: string[] = [];
    for (const id of ids) {
      const serialized = this.store.serializeTrack(id);
      if (!serialized) continue;
      const newId = this.store.nextTrackId();
      newIds.push(newId);
      const keyframes = { ...serialized.keyframes };
      keyframes.pos = keyframes.pos.map((v, i) => v + (i % 3 === 0 ? offset.x : i % 3 === 1 ? offset.y : offset.z));
      commands.push(
        new AddTrackCommand(this.store, {
          meta: { ...serialized.meta, id: newId, attributes: { ...serialized.meta.attributes } },
          keyframes,
          frameAttributes: serialized.frameAttributes,
        })
      );
    }
    if (commands.length === 1) this.history.push(commands[0]);
    else if (commands.length > 1) this.history.pushTransaction(commands);
    this.selection.select(newIds);
  }

  /** Dataset-level stats for the QA panel. */
  datasetStats(): { trackCount: number; keyframes: number; labeledFrames: number; coverage: number } {
    let labeled = 0;
    for (let f = 0; f < this.frameCount; f++) {
      if (this.store.activeTrackIds(f).length > 0) labeled++;
    }
    let keyframes = 0;
    for (const record of this.store.listTracks()) keyframes += record.kf.frames.length;
    return {
      trackCount: this.store.trackCount,
      keyframes,
      labeledFrames: labeled,
      coverage: this.frameCount > 0 ? labeled / this.frameCount : 0,
    };
  }

  // ---- undo / snapshots / export / assist ----

  undo(): void {
    this.history.undo();
  }

  redo(): void {
    this.history.redo();
  }

  exportSnapshot(): SnapshotDocument {
    return serializeStore(this.store, {
      sequenceId: this.manifest?.id ?? 'unknown',
      frameCount: this.frameCount,
      qa: this.qa,
    });
  }

  importSnapshot(doc: SnapshotDocument): void {
    applySnapshot(this.store, doc);
    if (doc.qa) this.qa = doc.qa;
  }

  exportNuScenes(options?: NuScenesExportOptions) {
    return exportNuScenesAnnotations(
      this.store,
      { sequenceId: this.manifest?.id ?? 'unknown', frameCount: this.frameCount },
      options
    );
  }

  async runAssist(adapter: AssistAdapter, minConfidence = 0.5): Promise<number> {
    const candidates = await adapter.generate({ frameCount: this.frameCount, fps: this.playhead.fps });
    const before = this.store.trackCount;
    applyCandidates(this.store, this.history, candidates, { minConfidence });
    return this.store.trackCount - before;
  }

  frameStats(): { activeTracks: number; totalTracks: number; keyframes: number } {
    let keyframes = 0;
    for (const record of this.store.listTracks()) keyframes += record.kf.frames.length;
    return {
      activeTracks: this.store.activeTrackIds(this.frame).length,
      totalTracks: this.store.trackCount,
      keyframes,
    };
  }

  bufferStats(): { pcd: ReturnType<FrameBuffer<PointCloudFrame>['stats']> | null; scheduler: ReturnType<TileScheduler['stats']> } {
    return {
      pcd: this.pcdFrames?.stats() ?? null,
      scheduler: this.scheduler.stats(),
    };
  }

  dispose(): void {
    this.playhead.dispose();
    this.pcdFrames?.clear();
    this.events.clear();
  }
}

function parseEgoArray(data: unknown, frameCount: number): Float64Array | null {
  if (!Array.isArray(data)) return null;
  const out = new Float64Array(frameCount * 16);
  const n = Math.min(data.length, frameCount);
  for (let i = 0; i < n; i++) {
    const m = data[i];
    if (!Array.isArray(m) || m.length !== 16) continue;
    for (let j = 0; j < 16; j++) out[i * 16 + j] = m[j];
  }
  return out;
}

function defaultHeightExtent(manifest: SequenceManifest) {
  // Without an explicit height tileset, reuse the BEV extent at 1m/px
  const bev = manifest.bev?.tileset;
  if (!bev) return null;
  return { ...bev, metersPerPixel: Math.max(1, bev.metersPerPixel) };
}

// local import to avoid pulling three into core: ray-OBB via geometry math
import { rayOBB } from '../geometry/math';
function rayOBBT(
  origin: Vec3,
  dir: Vec3,
  pos: Vec3,
  yaw: number,
  size: Vec3
): number | null {
  return rayOBB(origin, dir, pos, yaw, size);
}

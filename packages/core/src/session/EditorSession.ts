import { openManifestDataset } from '../dataset/ManifestDataset';
import { openNormalizedDataset } from '../dataset/NormalizedDataset';
import type { DatasetProvider, RuntimeSequence } from '../dataset/DatasetProvider';
import { mat4Invert, transformPoint } from '../geometry/math';
import { EventEmitter } from '../events/EventEmitter';
import { PatchCommand } from '../command/PatchCommand';
import type { DocumentStorage, DurableEdit } from '../persistence/DocumentStorage';
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
import type { PointCloudFrame } from '../io/pcd';
import type { SequenceManifest, TilesetConfig } from '../io/manifest';
import { applySnapshot, serializeStore } from '../io/snapshot';
import type { SnapshotDocument, SnapshotQA } from '../io/snapshot';
import { exportNuScenesAnnotations } from '../io/formats';
import type { NuScenesExportOptions } from '../io/formats';
import { applyCandidates } from '../assist/AssistAdapter';
import type { AssistAdapter } from '../assist/AssistAdapter';

export interface SessionEvents {
  frameChanged: { frame: number };
  frameStatusChanged: { requested: number; presented: number; status: 'loading' | 'ready' | 'error'; message?: string };
  qaChanged: { status: SnapshotQA['status'] };
  playbackChanged: { playing: boolean };
  saveChanged: { status: EditorSession['saveStatus']; revision: number; savedRevision: number; error?: string };
  manifestLoaded: { manifest: RuntimeSequence };
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

const defaultFetchImage: ImageFetcher = async (url, signal) => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Image HTTP ${response.status}: ${url}`);
  const blob = await response.blob();
  return createImageBitmap(blob, { imageOrientation: 'flipY' });
};

const defaultNet: NetClient = {
  fetchJson: async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`); return r.json(); },
  fetchBinary: async (url, init) => { const r = await fetch(url, init); if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`); return r.arrayBuffer(); },
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

  manifest: RuntimeSequence | null = null;
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

  readonly cameraFrames = new Map<string, FrameBuffer<ImageBitmap | HTMLImageElement>>();
  private dataset: DatasetProvider | null = null;
  private datasetLoad: AbortController | null = null;
  get datasetCapabilities() { return this.dataset?.capabilities ?? null; }
  get readOnly(): boolean { return this.dataset?.capabilities.editing === false; }
  cameraPoseTime(cameraId: string): number { return (this.dataset?.cameraPoseTime(cameraId, this.frame) ?? this.playhead.timeAt(this.frame) * 1e6) / 1e6; }
  private presentedFrame = 0;
  private loadEpoch = 0;
  private frameEpoch = 0;
  private disposed = false;
  frameStatus: 'loading' | 'ready' | 'error' = 'ready';
  heightPolicy: 'terrain' | 'zero-plane' = 'terrain';
  saveStatus: 'memory' | 'loading' | 'saved' | 'saving' | 'error' = 'memory';
  documentRevision = 0;
  savedRevision = 0;
  private storage: DocumentStorage | null = null;
  private persistenceRequired = false;
  private statsCache: { version: number; count: number; value: ReturnType<EditorSession['datasetStats']> } | null = null;
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
    this.history.setAtomic((fn) => {
      if (this.readOnly) throw new Error('Source observations are read-only');
      if (this.persistenceRequired && (!this.storage || this.saveStatus === 'loading')) throw new Error('Document storage is not writable');
      this.store.atomic(fn);
    });
    this.playhead.canAdvance = () => this.frameStatus === 'ready';
    this.oplog.snapshotProvider = () => this.exportSnapshot();

    this.history.setRecorder((cmd, action) => { this.oplog.record(cmd.name, cmd.payload, action); });
    this.history.events.on('changed', ({ canUndo, canRedo }) => {
      this.events.emit('historyChanged', { canUndo, canRedo });
    });
    this.store.events.on('changed', (change) => {
      if (this.qa.status !== 'pending') { this.qa = { ...this.qa, status: 'pending' }; this.events.emit('qaChanged', { status: 'pending' }); }
      this.events.emit('storeChanged', change);
    });
    this.selection.events.on('changed', ({ version }) => {
      this.events.emit('selectionChanged', { version });
    });
    this.tools.events.on('changed', ({ tool, state }) => {
      if (state.name !== 'idle' && state.name !== 'marquee') this.pause();
      this.events.emit('toolChanged', { tool });
    });
    this.playhead.events.on('frame', ({ frame }) => {
      this.tools.cancel();
      void this.requestFrame(frame);
    });
    this.playhead.events.on('playing', (event) => this.events.emit('playbackChanged', event));
    this.history.events.on('failed', ({ error }) => this.events.emit('error', { message: String(error) }));
  }

  registerEvictHandler(prefix: string, handler: (id: string, resource: unknown) => void): void {
    this.evictHandlers.set(prefix, handler);
  }

  get frame(): number {
    return this.presentedFrame;
  }

  get frameCount(): number {
    return this.manifest?.frameCount ?? 1;
  }

  // ---- manifest / resources ----

  async loadManifest(input: SequenceManifest): Promise<void> {
    await this.openDataset((signal) => openManifestDataset(input, {
      net: this.deps.net ?? defaultNet, fetchImage: this.deps.fetchImage ?? defaultFetchImage,
    }, signal));
  }

  async loadNormalized(input: unknown, url: string): Promise<void> {
    await this.openDataset((signal) => openNormalizedDataset(input, url, signal));
  }

  private async openDataset(open: (signal: AbortSignal) => Promise<DatasetProvider>): Promise<void> {
    if (this.history.pending) throw new Error('Wait for the current save before switching sequences');
    this.datasetLoad?.abort();
    const controller = new AbortController(); this.datasetLoad = controller;
    const epoch = ++this.loadEpoch;
    this.frameEpoch++; this.pause(); this.tools.cancel();
    try {
      const dataset = await open(controller.signal);
      if (this.disposed || epoch !== this.loadEpoch) { dataset.dispose(); return; }
      await this.loadRuntime(dataset.description, dataset);
    } catch (error) {
      const obsolete = controller.signal.aborted || this.disposed;
      controller.abort();
      if (!obsolete) throw error;
    } finally { if (this.datasetLoad === controller) this.datasetLoad = null; }
  }

  private async loadRuntime(manifest: RuntimeSequence, dataset: DatasetProvider): Promise<void> {
    if (this.history.pending) throw new Error('Wait for the current save before switching sequences');
    const epoch = ++this.loadEpoch;
    this.frameEpoch++; this.pause(); this.tools.cancel();
    const ego = new EgoTrack(dataset.egoPoses, manifest.frameCount);
    if (epoch !== this.loadEpoch || this.disposed) return;
    this.frameEpoch++;
    this.storage?.close(); this.storage = null; this.history.setCommitter(null); this.saveStatus = 'memory'; this.persistenceRequired = false;
    this.documentRevision = 0; this.savedRevision = 0;
    this.releaseResources();
    this.dataset = dataset; this.store.setObservationSource(null);
    this.store.clear(); this.selection.clear(); this.history.clear(); this.oplog.clear();
    this.qa = { status: 'pending', notes: '' }; this.hover = null; this.hiddenLabels.clear(); this.setBlinkLabel(null);
    this.manifest = manifest; this.ego = ego;
    this.store.setObservationSource(dataset.observations);
    this.labels = manifest.labels?.length ? manifest.labels : DEFAULT_LABELS;
    this.playhead.fps = manifest.fps;
    this.presentedFrame = 0;
    this.playhead.setFrameCount(manifest.frameCount); this.playhead.setTimeMicros(dataset.timeMicros); this.playhead.setFrame(0);

    this.projectors.clear();
    for (const camera of manifest.cameras ?? []) {
      const projector = CameraProjector.create(camera, this.ego);
      projector.poseProvider = (frame) => dataset.cameraPose(camera.id, frame);
      if (dataset.sourceProjection) {
        const projection = dataset.sourceProjection;
        projector.sourceBoxes = (frame) => projection.cameraBoxes(camera.id, frame);
        projector.sourceCameraId = projection.cameraSourceId(camera.id);
      }
      this.projectors.set(camera.id, projector);
    }
    this.activeCameraId = manifest.cameras?.[0]?.id ?? null;

    const pointCloud = 'pointCloud' in manifest ? manifest.pointCloud : null;
    if (dataset.cloud) {
      this.pcdFrames = new FrameBuffer<PointCloudFrame>(
        dataset.cloud,
        this.scheduler,
        {
          windowAhead: this.deps.pointCloudWindow?.ahead ?? 3,
          windowBehind: this.deps.pointCloudWindow?.behind ?? 1,
          budgetBytes: this.deps.pointCloudWindow?.budgetBytes ?? 512 * 1024 * 1024,
          idPrefix: `${manifest.id}:load${epoch}:pcd`,
          estimateBytes: pointCloud?.approxBytesPerFrame ?? 16 * 1024 * 1024,
          frameCount: manifest.frameCount,
        }
      );
    } else {
      this.pcdFrames = null;
    }

    for (const camera of manifest.cameras ?? []) {
      const buffer = new FrameBuffer<ImageBitmap | HTMLImageElement>(
        dataset.image(camera.id),
        this.scheduler,
        { windowAhead: 1, windowBehind: 0, budgetBytes: 128 * 1024 * 1024,
          estimateBytes: camera.width * camera.height * 4, idPrefix: `${manifest.id}:load${epoch}:camera:${camera.id}`, frameCount: manifest.frameCount }
      );
      this.cameraFrames.set(camera.id, buffer);
    }
    this.imageFrames = this.activeCameraId ? this.cameraFrames.get(this.activeCameraId) ?? null : null;

    if (manifest.bev?.tileset) {
      this.bevPyramid = new BevPyramid(manifest.bev.tileset);
    } else if (manifest.bev?.image) {
      const image = manifest.bev.image;
      this.bevPyramid = new BevPyramid({ ...image, tileSize: Math.max(image.width, image.height), urlTemplate: image.url }, true);
    } else {
      this.bevPyramid = null;
    }

    if ('height' in manifest && manifest.height) {
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
    await this.requestFrame(0);
  }

  // ---- frame / playback ----

  setFrame(frame: number): void {
    if (!Number.isFinite(frame)) return;
    this.tools.cancel();
    this.playhead.setFrame(frame);
  }

  play(): void {
    this.playhead.play();
  }

  pause(): void {
    this.playhead.pause();
  }

  get selectionPreview(): import('../render/TrackInstanceRenderer').InstancePreview | null {
    if (this.readOnly) return null;
    const delta = this.tools.movePreviewDelta(), rotation = this.tools.rotatePreviewDelta();
    const ids = new Set(this.selection.all());
    if (delta) return { ids, delta };
    if (rotation) return { ids, delta: vec3(), pivot: rotation.pivot, dyaw: rotation.dyaw };
    return null;
  }

  get requestedFrame(): number { return this.playhead.frame; }

  private async requestFrame(frame: number): Promise<void> {
    const epoch = ++this.frameEpoch;
    this.frameStatus = 'loading'; this.emitFrameStatus();
    this.pcdFrames?.setFrame(frame);
    for (const buffer of this.cameraFrames.values()) buffer.setFrame(frame);
    try {
      const cloud = this.pcdFrames?.ensure(frame);
      const images = [...this.cameraFrames.values()].map((buffer) => this.dataset?.capabilities.imageFailure === 'required' ? buffer.ensure(frame) : buffer.ensure(frame).catch(() => null));
      await Promise.all([cloud, ...images]);
      if (epoch !== this.frameEpoch || this.disposed) return;
      this.presentedFrame = frame;
      this.pcdFrames?.setPresented(frame);
      for (const buffer of this.cameraFrames.values()) buffer.setPresented(frame);
      this.frameStatus = 'ready'; this.emitFrameStatus();
      this.events.emit('frameChanged', { frame });
    } catch (error) {
      if (epoch !== this.frameEpoch || this.disposed) return;
      this.frameStatus = 'error'; this.pause(); this.emitFrameStatus(String(error));
      this.events.emit('error', { message: String(error) });
    }
  }

  retryFrame(): void {
    this.pcdFrames?.retry(this.requestedFrame).catch(() => {});
    for (const buffer of this.cameraFrames.values()) buffer.retry(this.requestedFrame).catch(() => {});
    void this.requestFrame(this.requestedFrame);
  }

  private emitFrameStatus(message?: string): void {
    this.events.emit('frameStatusChanged', { requested: this.requestedFrame, presented: this.frame, status: this.frameStatus, message });
  }
  currentPointCloud(): PointCloudFrame | null { return this.pcdFrames?.get(this.frame) ?? null; }
  currentCameraImage(cameraId = this.activeCameraId): ImageBitmap | HTMLImageElement | null {
    return cameraId ? this.cameraFrames.get(cameraId)?.get(this.frame) ?? null : null;
  }

  // ---- intents -> commands ----

  applyIntent(intent: ToolIntent): void {
    try { this.applyIntentChecked(intent); } catch (error) { this.events.emit('error', { message: String(error) }); }
  }

  private applyIntentChecked(intent: ToolIntent): void {
    if (!['select', 'selectRect', 'none', 'measureDone'].includes(intent.type) && !this.canEdit) {
      throw new Error('Wait for the requested frame before editing');
    }
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
        vertices[intent.index * 3 + 1] = Number.isFinite(intent.pos.y) ? intent.pos.y : this.sampleHeight(intent.pos.x, intent.pos.z);
        vertices[intent.index * 3 + 2] = intent.pos.z;
        this.history.push(new UpdateGeometryCommand(this.store, intent.id, vertices));
        break;
      }
      case 'deleteGeometryVertex': {
        this.pause();
        const record = this.store.getGeometry(intent.id);
        if (!record) break;
        const n = record.vertices.length / 3;
        if (n <= (record.meta.closed ? 3 : 2)) break; // keep at least a segment
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
          for (const id of trackIds) {
            const state = this.store.resolveState(id, this.frame);
            if (state) commands.push(new SetKeyframeCommand(this.store, id, this.frame,
              { ...state, pos: vec3(state.pos.x + delta.x, state.pos.y + delta.y, state.pos.z + delta.z) }));
          }
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
        const commands = ids.flatMap((id) => {
          const state = this.store.resolveState(id, this.frame);
          if (!state) return [];
          const dx = state.pos.x - intent.pivot.x, dz = state.pos.z - intent.pivot.z;
          const c = Math.cos(intent.dyaw), s = Math.sin(intent.dyaw);
          return [new SetKeyframeCommand(this.store, id, this.frame, { ...state,
            pos: vec3(intent.pivot.x + dx * c + dz * s, state.pos.y, intent.pivot.z - dx * s + dz * c),
            yaw: state.yaw + intent.dyaw })];
        });
        if (commands.length === 1) this.history.push(commands[0]);
        else if (commands.length) this.history.pushTransaction(commands);
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
    if (this.readOnly && tool !== 'select' && tool !== 'measure') return;
    this.tools.setTool(tool);
  }

  // ---- track/geometry editing API (panels) ----

  setKeyframeAtCurrentFrame(id: TrackId): void {
    if (!this.canEdit) return;
    this.pause();
    const state = this.store.resolveState(id, this.frame);
    if (!state) return;
    this.history.push(new SetKeyframeCommand(this.store, id, this.frame, state as KeyframeState));
  }

  removeKeyframeAtCurrentFrame(id: TrackId): void {
    if (!this.canEdit) return;
    this.pause();
    this.history.push(new RemoveKeyframeCommand(this.store, id, this.frame));
  }

  copyStateToFrame(id: TrackId, toFrame: number): void {
    if (!this.canEdit || !Number.isSafeInteger(toFrame) || toFrame < 0 || toFrame >= this.frameCount) return;
    this.pause();
    const state = this.store.resolveState(id, this.frame);
    if (!state) return;
    this.history.push(new SetKeyframeCommand(this.store, id, toFrame, state as KeyframeState));
  }

  deleteSelection(): void {
    if (!this.canEdit) return;
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
    if (!this.canEdit) return;
    const id = this.selection.first;
    if (!id || !this.store.getTrack(id)) return;
    this.pause();
    this.history.push(new SplitTrackCommand(this.store, id, this.frame, this.store.nextTrackId()));
  }

  mergeSelectedTracks(): void {
    if (!this.canEdit) return;
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
    if (!this.canEdit) return;
    const record = this.store.getTrack(id);
    if (!record) return;
    this.history.push(
      new SetTrackMetaCommand(this.store, id, { attributes: { ...record.meta.attributes, [key]: value } })
    );
  }

  setFrameAttribute(id: TrackId, key: string, value: string | number | boolean | null): void {
    if (!this.canEdit) return;
    this.history.push(new SetFrameAttributeCommand(this.store, id, this.frame, key, value));
  }

  // ---- picking helpers ----

  /** Nearest track box hit by a world-space ray (origin + direction). */
  pickTrackByRay(origin: Vec3, dir: Vec3, frame: number): { id: string; t: number } | null {
    let best: { id: string; t: number } | null = null;
    for (const id of this.store.activeTrackIds(frame)) {
      if (this.hiddenLabels.has(this.store.getTrack(id)?.meta.label ?? '')) continue;
      const state = this.store.resolveState(id, frame);
      if (!state) continue;
      let t: number | null;
      if (state.boxToWorld) {
        const inv = new Float64Array(16); mat4Invert(state.boxToWorld, inv);
        const localOrigin = vec3(), localTip = vec3();
        transformPoint(inv, origin, localOrigin);
        transformPoint(inv, { x: origin.x + dir.x, y: origin.y + dir.y, z: origin.z + dir.z }, localTip);
        t = rayOBBT(localOrigin, { x: localTip.x-localOrigin.x, y: localTip.y-localOrigin.y, z: localTip.z-localOrigin.z }, vec3(), 0, state.size);
      } else t = rayOBBT(origin, dir, state.pos, state.yaw, state.size);
      if (t !== null && (!best || t < best.t)) best = { id, t };
    }
    return best;
  }

  /** Nearest geometry polyline within tolerance of a ground point. */
  pickGeometryAtWorld(world: Vec3, tolerance: number): string | null {
    let best: string | null = null;
    let bestDist = tolerance;
    for (const geom of this.store.geometriesAt(this.frame)) {
      if (this.hiddenLabels.has(geom.meta.label)) continue;
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
    if (this.heightPolicy === 'zero-plane') return 0;
    const sample = this.heightField?.sampleState(x, z);
    if (sample?.status === 'ready') return sample.value;
    throw new Error('Terrain height is unavailable; wait for it or explicitly select the zero plane');
  }

  get canEdit(): boolean { return !this.readOnly && this.frameStatus === 'ready' && !this.history.pending && this.saveStatus !== 'loading' && (!this.persistenceRequired || Boolean(this.storage)); }

  setQA(status: SnapshotQA['status']): void {
    if (!this.canEdit) return;
    if (this.storage) {
      this.history.push({ name: 'set_review', payload: { status }, apply() {}, undo() {} });
    } else this.publishReview({ ...this.qa, status });
  }

  private publishReview(review: SnapshotQA): void {
    this.qa = { ...review }; this.events.emit('qaChanged', { status: this.qa.status });
  }

  private emitSave(error?: string): void {
    this.events.emit('saveChanged', { status: this.saveStatus, revision: this.documentRevision, savedRevision: this.savedRevision, error });
  }

  async enablePersistence(storage: DocumentStorage): Promise<void> {
    this.assertEditableFormat();
    if (!this.manifest || this.history.pending) throw new Error('Load a sequence and finish editing before opening storage');
    this.storage?.close(); this.storage = storage; this.persistenceRequired = true;
    this.saveStatus = 'loading'; this.emitSave();
    const epoch = this.loadEpoch;
    try {
      const recovered = await storage.open(this.manifest.id, this.exportSnapshot());
      if (this.disposed || epoch !== this.loadEpoch || this.storage !== storage) { storage.close(); return; }
      if (recovered.schema !== 'label4d.local.v1' || recovered.baseline.sequenceId !== this.manifest.id ||
          recovered.baseline.frameCount !== this.frameCount) throw new Error('Stored document schema or dataset does not match');
      const candidate = new TrackStore(); applySnapshot(candidate, recovered.baseline);
      const ids = new Set<string>(); let revision = 0;
      const undo: Command[] = [], redo: Command[] = [];
      let review = recovered.baseline.qa ?? { status: 'pending' as const };
      for (const edit of recovered.edits) {
        if (!edit.operationId || ids.has(edit.operationId) || edit.beforeRevision !== revision || edit.revision !== revision + 1 ||
            !['apply', 'undo', 'redo'].includes(edit.action) || !edit.review || !edit.inverseReview ||
            !['pending', 'pass', 'reject'].includes(edit.review.status) || !['pending', 'pass', 'reject'].includes(edit.inverseReview.status)) throw new Error('Stored operation log is discontinuous or corrupt');
        ids.add(edit.operationId); revision = edit.revision;
        candidate.applyPatch(edit.patch); review = edit.review;
        const command = new PatchCommand(this.store, edit.patch, edit.inverse, edit.review, edit.inverseReview, (qa) => this.publishReview(qa));
        if (edit.action === 'apply') { undo.push(command); redo.length = 0; }
        else if (edit.action === 'undo') { const original = undo.pop(); if (!original) throw new Error('Invalid persisted undo'); redo.push(original); }
        else { const original = redo.pop(); if (!original) throw new Error('Invalid persisted redo'); undo.push(original); }
      }
      if (revision !== recovered.revision) throw new Error('Stored head revision does not match the log');
      this.store.replaceWith(candidate); this.publishReview(review);
      this.history.restore(undo, redo); this.oplog.clear();
      this.documentRevision = revision; this.savedRevision = revision;
      this.history.setCommitter((cmd, action) => this.persistEdit(cmd, action));
      this.saveStatus = 'saved'; this.emitSave();
    } catch (error) {
      storage.close(); if (this.storage === storage) this.storage = null;
      if (!this.disposed) { this.saveStatus = 'error'; this.emitSave(String(error)); }
      throw error;
    }
  }

  private async persistEdit(cmd: Command, action: DurableEdit['action']): Promise<Command> {
    const storage = this.storage; if (!storage) throw new Error('Document storage is unavailable');
    const beforeReview = { ...this.qa };
    let desiredReview: SnapshotQA = { ...beforeReview, status: 'pending' };
    let executable = cmd;
    if (action === 'apply' && cmd.name !== 'patch') {
      if (cmd.name === 'set_review') {
        desiredReview = { ...beforeReview, ...(cmd.payload as { status: SnapshotQA['status'] }) };
      } else if (cmd.name === 'replace_document') {
        const snapshot = cmd.payload as SnapshotDocument;
        executable = { ...cmd, apply: () => applySnapshot(this.store, snapshot) };
        desiredReview = snapshot.qa ?? { status: 'pending' };
      } else executable = createCommand(this.store, cmd.name, cmd.payload as never);
    } else if (cmd instanceof PatchCommand) {
      desiredReview = action === 'undo' ? cmd.payload.inverseReview : cmd.payload.review;
    }
    const staged = this.store.stage(() => {
      if (executable instanceof PatchCommand) this.store.applyPatch(action === 'undo' ? executable.payload.inverse : executable.payload.patch);
      else if (action === 'undo') executable.undo(); else executable.apply();
    });
    // PatchCommand may update review during staging; nothing staged is observable after this turn.
    this.qa = beforeReview;
    const committed = action === 'apply' ? new PatchCommand(this.store, staged.after, staged.before,
      desiredReview, beforeReview, (qa) => this.publishReview(qa)) : cmd;
    const edit: DurableEdit = { operationId: crypto.randomUUID(), beforeRevision: this.documentRevision,
      revision: this.documentRevision + 1, action, patch: staged.after, inverse: staged.before,
      review: desiredReview, inverseReview: beforeReview };
    this.saveStatus = 'saving'; this.emitSave();
    try {
      await storage.append(edit);
      if (this.disposed || this.storage !== storage) return committed;
      this.store.applyPatch(edit.patch); this.publishReview(desiredReview);
      this.documentRevision = edit.revision; this.savedRevision = edit.revision;
      this.oplog.record('patch', { patch: edit.patch, inverse: edit.inverse }, action);
      this.saveStatus = 'saved'; this.emitSave(); return committed;
    } catch (error) { this.saveStatus = 'error'; this.emitSave(String(error)); throw error; }
  }

  setTrackMeta(id: TrackId, patch: Partial<Omit<SerializedTrack['meta'], 'id'>>): void {
    if (!this.canEdit) return;
    this.pause(); this.history.push(new SetTrackMetaCommand(this.store, id, patch));
  }
  updateGeometry(id: string, patch: Partial<Omit<import('../model/types').GeometryMeta, 'id'>>): void {
    if (!this.canEdit) return;
    this.pause(); this.history.push(new UpdateGeometryCommand(this.store, id, undefined, patch));
  }
  editKeyframe(id: TrackId, frame: number, state: KeyframeState): void {
    if (!this.canEdit || frame !== this.frame) throw new Error('Cannot edit an unpresented frame');
    this.pause(); this.history.push(new SetKeyframeCommand(this.store, id, frame, state));
  }

  /** Arrow-key nudge of the selection (tracks + geometry), one undo step. */
  nudgeSelection(delta: Vec3): void {
    if (this.selection.size === 0) return;
    this.applyIntent({ type: 'moveSelection', delta });
  }

  /** Duplicate selected tracks with a lateral offset, selecting the copies. */
  duplicateSelection(offset: Vec3 = vec3(2, 0, 2)): void {
    if (!this.canEdit) return;
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
    if (this.statsCache?.version === this.store.currentVersion && this.statsCache.count === this.frameCount) return this.statsCache.value;
    if (this.dataset?.observations) {
      const labeledFrames = this.dataset.observations.active.filter((ids) => ids.length > 0).length;
      return { trackCount: this.store.trackCount, keyframes: this.store.listTracks().reduce((n, r) => n + r.kf.frames.length, 0), labeledFrames, coverage: labeledFrames / this.frameCount };
    }
    const intervals = this.store.listTracks().filter((r) => r.kf.frames.length).map((r) =>
      [Math.max(0, r.meta.startFrame), Math.min(this.frameCount - 1, r.meta.endFrame)]).sort((a, b) => a[0] - b[0]);
    let labeled = 0, start = -1, end = -1;
    for (const [a, b] of intervals) {
      if (a > b) continue;
      if (start < 0) { start = a; end = b; }
      else if (a <= end + 1) end = Math.max(end, b);
      else { labeled += end - start + 1; start = a; end = b; }
    }
    if (start >= 0) labeled += end - start + 1;
    const value = { trackCount: this.store.trackCount,
      keyframes: this.store.listTracks().reduce((n, r) => n + r.kf.frames.length, 0),
      labeledFrames: labeled, coverage: labeled / this.frameCount };
    this.statsCache = { version: this.store.currentVersion, count: this.frameCount, value };
    return value;
  }

  // ---- undo / snapshots / export / assist ----

  undo(): void {
    if (!this.canEdit) return;
    this.pause(); this.tools.cancel();
    this.history.undo();
  }

  redo(): void {
    if (!this.canEdit) return;
    this.pause(); this.tools.cancel();
    this.history.redo();
  }

  private assertEditableFormat(): void {
    if (this.readOnly) throw new Error('Full-pose source observations are read-only; v1 editing, persistence and export are unavailable');
  }

  exportSnapshot(): SnapshotDocument {
    this.assertEditableFormat();
    return serializeStore(this.store, {
      sequenceId: this.manifest?.id ?? 'unknown',
      frameCount: this.frameCount,
      qa: this.qa,
    });
  }

  importSnapshot(doc: SnapshotDocument): void {
    this.assertEditableFormat();
    if (this.manifest && (doc.sequenceId !== this.manifest.id || doc.frameCount !== this.frameCount)) throw new Error('Snapshot belongs to another sequence');
    this.pause(); this.tools.cancel();
    if (this.storage) {
      this.history.push({ name: 'replace_document', payload: structuredClone(doc), apply() {}, undo() {} });
      this.selection.clear(); return;
    }
    applySnapshot(this.store, doc);
    this.selection.clear(); this.history.clear(); this.oplog.clear();
    this.qa = doc.qa ? { ...doc.qa } : { status: 'pending' };
    this.events.emit('qaChanged', { status: this.qa.status });
  }

  exportNuScenes(options?: NuScenesExportOptions) {
    this.assertEditableFormat();
    return exportNuScenesAnnotations(
      this.store,
      { sequenceId: this.manifest?.id ?? 'unknown', frameCount: this.frameCount },
      options
    );
  }

  async runAssist(adapter: AssistAdapter, minConfidence = 0.5): Promise<number> {
    if (!this.canEdit) return 0;
    const epoch = this.loadEpoch;
    const candidates = await adapter.generate({ frameCount: this.frameCount, fps: this.playhead.fps });
    if (epoch !== this.loadEpoch || this.disposed) return 0;
    const before = this.store.trackCount;
    applyCandidates(this.store, this.history, candidates, { minConfidence });
    await this.history.whenIdle();
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

  private releaseResources(): void {
    this.dataset?.dispose(); this.dataset = null;
    this.pcdFrames?.dispose(); this.pcdFrames = null;
    for (const buffer of this.cameraFrames.values()) buffer.dispose();
    this.cameraFrames.clear(); this.imageFrames = null;
    this.heightField?.dispose(); this.heightField = null;
    this.potree = null; this.bevPyramid = null;
  }

  dispose(): void {
    this.datasetLoad?.abort(); this.datasetLoad = null;
    this.disposed = true; this.loadEpoch++; this.frameEpoch++;
    this.storage?.close(); this.storage = null;
    this.setBlinkLabel(null); this.playhead.dispose(); this.releaseResources(); this.scheduler.dispose();
    this.events.clear(); this.store.events.clear(); this.selection.events.clear(); this.tools.events.clear();
  }
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

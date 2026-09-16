import * as THREE from 'three';
import { boxCorners, composeBoxMatrix } from '../geometry/math';
import type { Vec3 } from '../geometry/math';
import type { TrackStore } from '../model/TrackStore';
import type { SelectionSet } from '../model/SelectionSet';
import type { LabelDef } from '../model/types';
import { colorForLabel, makeDynamicLines, BOX_EDGES } from './shared';
import type { DynamicLines } from './shared';

export interface ViewFilter {
  hiddenLabels: Set<string>;
  blinkLabel: string | null;
  blinkOn: boolean;
  /** show velocity arrows for these track ids (selection + hover) */
  velocityIds: Set<string>;
}

/** Render-layer-only preview transform while a drag gesture is active. */
export interface InstancePreview {
  ids: Set<string>;
  delta: Vec3;
  pivot?: Vec3;
  dyaw?: number;
}

const WHITE = new THREE.Color(0xffffff);
const SELECTION_COLOR = new THREE.Color(0xfff36b);
const VELOCITY_COLOR = new THREE.Color(0x3ddc97);

/**
 * Dynamic-object rendering: one InstancedMesh for all active 3D boxes at the
 * current frame (matrix + per-instance label color), plus dynamic line layers
 * for selection outlines and static geometry (lanes, curbs, polygons).
 * Sync is incremental by (frame, store version, selection version, preview) —
 * no per-frame rebuilds of GPU resources.
 */
export class TrackInstanceRenderer {
  readonly group = new THREE.Group();

  private mesh: THREE.InstancedMesh;
  private capacity = 512;
  private readonly matrixScratch = new Float32Array(16);
  private readonly matrixObj = new THREE.Matrix4();
  private readonly colorObj = new THREE.Color();
  private readonly corners = new Float64Array(24);
  private readonly lineBuf: Float32Array;
  private preview: InstancePreview | null = null;
  private lastSyncKey = '';
  private readonly selectionLines: DynamicLines;
  private readonly geometryLines: DynamicLines;
  private readonly velocityLines: DynamicLines;
  private filter: ViewFilter = { hiddenLabels: new Set(), blinkLabel: null, blinkOn: false, velocityIds: new Set() };

  constructor(
    private readonly store: TrackStore,
    private readonly selection: SelectionSet,
    private readonly labels: LabelDef[]
  ) {
    this.mesh = this.buildMesh(this.capacity);
    this.group.add(this.mesh);
    this.lineBuf = new Float32Array(65536 * 3);
    this.selectionLines = makeDynamicLines(65536, { color: 0xfff36b, depthTest: false });
    this.geometryLines = makeDynamicLines(131072, { vertexColors: true, opacity: 0.95 });
    this.velocityLines = makeDynamicLines(4096, { color: 0x3ddc97, depthTest: false });
    this.group.add(this.selectionLines.object);
    this.group.add(this.geometryLines.object);
    this.group.add(this.velocityLines.object);
  }

  setFilter(filter: Partial<ViewFilter>): void {
    this.filter = { ...this.filter, ...filter };
  }

  setPreview(preview: InstancePreview | null): void {
    this.preview = preview;
    this.lastSyncKey = '';
  }

  sync(frame: number, hoverId: string | null = null): void {
    const key = `${frame}:${this.store.currentVersion}:${this.selection.currentVersion}:${hoverId ?? ''}:${this.preview ? 'p' : ''}:${this.filter.blinkLabel ?? ''}${this.filter.blinkOn ? 'B' : ''}:${this.filter.hiddenLabels.size}`;
    if (key === this.lastSyncKey) return;
    this.lastSyncKey = key;

    const ids = this.store.activeTrackIds(frame);
    if (ids.length > this.capacity) this.grow(ids.length);

    let slot = 0;
    for (const id of ids) {
      const record = this.store.getTrack(id);
      if (record && this.filter.hiddenLabels.has(record.meta.label)) continue; // class visibility filter
      const state = this.store.resolveState(id, frame);
      if (!state) continue;
      const adjusted = this.applyPreview(id, state.pos, state.yaw);
      composeBoxMatrix(adjusted.pos, adjusted.yaw, state.size, this.matrixScratch);
      this.matrixObj.fromArray(Array.from(this.matrixScratch));
      this.mesh.setMatrixAt(slot, this.matrixObj);

      const label = record?.meta.label ?? '';
      this.colorObj.set(colorForLabel(this.labels, label));
      if (this.filter.blinkLabel === label && this.filter.blinkOn) {
        this.colorObj.lerp(WHITE, 0.9); // blink highlight flash
      }
      if (this.selection.has(id)) this.colorObj.lerp(SELECTION_COLOR, 0.75);
      else if (hoverId === id) this.colorObj.lerp(WHITE, 0.35);
      this.mesh.setColorAt(slot, this.colorObj);
      slot++;
    }
    this.mesh.count = slot;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.syncVelocityArrows(ids, frame);
    this.syncSelectionOutlines(ids, frame);
    this.syncGeometryLines(frame);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    this.selectionLines.dispose();
    this.geometryLines.dispose();
    this.velocityLines.dispose();
  }

  /**
   * Velocity arrow (green) for selected/hovered tracks, derived from the
   * neighbouring keyframes: v = Δpos / Δt, drawn from the box top center.
   */
  private syncVelocityArrows(ids: string[], frame: number): void {
    let v = 0;
    const buf = this.lineBuf;
    for (const id of ids) {
      if (!this.filter.velocityIds.has(id)) continue;
      const record = this.store.getTrack(id);
      if (!record) continue;
      const kf = record.kf;
      const idx = kf.frames.indexOf(frame);
      if (idx < 0) continue;
      const pa = idx > 0 ? idx - 1 : idx;
      const pb = idx < kf.frames.length - 1 ? idx + 1 : idx;
      if (pa === pb) continue;
      const dt = (kf.frames[pb] - kf.frames[pa]) / Math.max(1, this.fps);
      if (dt <= 0) continue;
      const ax = kf.pos[pa * 3], ay = kf.pos[pa * 3 + 1], az = kf.pos[pa * 3 + 2];
      const bx = kf.pos[pb * 3], by = kf.pos[pb * 3 + 1], bz = kf.pos[pb * 3 + 2];
      const speed = Math.hypot(bx - ax, by - ay, bz - az) / dt;
      if (speed < 0.05) continue;
      const state = this.store.resolveState(id, frame);
      if (!state) continue;
      const originY = state.pos.y + state.size.y / 2 + 0.2;
      const scale = 0.4; // arrow length in world meters per m/s
      const dir = { x: (bx - ax) / (dt * speed), y: (by - ay) / (dt * speed), z: (bz - az) / (dt * speed) };
      const len = Math.min(speed * scale, 12);
      const tip = { x: state.pos.x + dir.x * len, y: originY + dir.y * len, z: state.pos.z + dir.z * len };
      if (v + 3 > buf.length / 3) break;
      // shaft
      buf[v * 3] = state.pos.x; buf[v * 3 + 1] = originY; buf[v * 3 + 2] = state.pos.z; v++;
      buf[v * 3] = tip.x; buf[v * 3 + 1] = tip.y; buf[v * 3 + 2] = tip.z; v++;
      // arrow head (two short lines)
      for (const side of [-1, 1]) {
        buf[v * 3] = tip.x; buf[v * 3 + 1] = tip.y; buf[v * 3 + 2] = tip.z; v++;
        buf[v * 3] = tip.x - dir.x * 0.5 + -dir.z * side * 0.3;
        buf[v * 3 + 1] = tip.y;
        buf[v * 3 + 2] = tip.z - dir.z * 0.5 + dir.x * side * 0.3;
        v++;
      }
    }
    this.velocityLines.update(buf, v);
  }

  /** sequence fps for velocity derivation (set by the view from the session) */
  fps = 10;

  private applyPreview(id: string, pos: Vec3, yaw: number): { pos: Vec3; yaw: number } {
    const preview = this.preview;
    if (!preview || !preview.ids.has(id)) return { pos, yaw };
    let px = pos.x + preview.delta.x;
    let pz = pos.z + preview.delta.z;
    let pyaw = yaw;
    if (preview.pivot && preview.dyaw) {
      const dx = px - preview.pivot.x;
      const dz = pz - preview.pivot.z;
      const c = Math.cos(preview.dyaw);
      const s = Math.sin(preview.dyaw);
      px = preview.pivot.x + dx * c + dz * s;
      pz = preview.pivot.z + -dx * s + dz * c;
      pyaw = yaw + preview.dyaw;
    }
    return { pos: { x: px, y: pos.y + preview.delta.y, z: pz }, yaw: pyaw };
  }

  private syncSelectionOutlines(ids: string[], frame: number): void {
    let v = 0;
    for (const id of ids) {
      if (!this.selection.has(id)) continue;
      const state = this.store.resolveState(id, frame);
      if (!state) continue;
      const adjusted = this.applyPreview(id, state.pos, state.yaw);
      boxCorners(adjusted.pos, adjusted.yaw, state.size, this.corners);
      for (const [a, b] of BOX_EDGES) {
        if (v + 2 > this.lineBuf.length / 3) break;
        this.lineBuf[v * 3] = this.corners[a * 3];
        this.lineBuf[v * 3 + 1] = this.corners[a * 3 + 1];
        this.lineBuf[v * 3 + 2] = this.corners[a * 3 + 2];
        v++;
        this.lineBuf[v * 3] = this.corners[b * 3];
        this.lineBuf[v * 3 + 1] = this.corners[b * 3 + 1];
        this.lineBuf[v * 3 + 2] = this.corners[b * 3 + 2];
        v++;
      }
    }
    this.selectionLines.update(this.lineBuf, v);
  }

  private syncGeometryLines(frame: number): void {
    const geometries = this.store.geometriesAt(frame);
    const colors = new Float32Array(this.lineBuf.length);
    let v = 0;
    const color = new THREE.Color();
    for (const geom of geometries) {
      if (this.filter.hiddenLabels.has(geom.meta.label)) continue; // class visibility filter
      const n = geom.vertices.length / 3;
      color.set(colorForLabel(this.labels, geom.meta.label));
      for (let i = 0; i < n; i++) {
        const j = geom.meta.closed ? (i + 1) % n : i + 1;
        if (j >= n) continue;
        if (v + 2 > this.lineBuf.length / 3) break;
        this.lineBuf[v * 3] = geom.vertices[i * 3];
        this.lineBuf[v * 3 + 1] = geom.vertices[i * 3 + 1];
        this.lineBuf[v * 3 + 2] = geom.vertices[i * 3 + 2];
        colors[v * 3] = color.r;
        colors[v * 3 + 1] = color.g;
        colors[v * 3 + 2] = color.b;
        v++;
        this.lineBuf[v * 3] = geom.vertices[j * 3];
        this.lineBuf[v * 3 + 1] = geom.vertices[j * 3 + 1];
        this.lineBuf[v * 3 + 2] = geom.vertices[j * 3 + 2];
        colors[v * 3] = color.r;
        colors[v * 3 + 1] = color.g;
        colors[v * 3 + 2] = color.b;
        v++;
      }
    }
    this.geometryLines.update(this.lineBuf, v);
    const colorAttr = this.geometryLines.object.geometry.getAttribute('color') as THREE.BufferAttribute;
    if (colorAttr) {
      (colorAttr.array as Float32Array).set(colors.subarray(0, v * 3));
      colorAttr.needsUpdate = true;
    }
  }

  private grow(minCapacity: number): void {
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.capacity = Math.max(minCapacity * 2, this.capacity * 2);
    this.mesh = this.buildMesh(this.capacity);
    this.group.add(this.mesh);
  }

  private buildMesh(capacity: number): THREE.InstancedMesh {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.92 });
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    for (let i = 0; i < capacity; i++) mesh.setColorAt(i, this.colorObj.setHex(0xffffff));
    if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }
}

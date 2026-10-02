import { previewPose } from '../geometry/math';
import type { InstancePreview } from './TrackInstanceRenderer';
import * as THREE from 'three';
import { boxCorners } from '../geometry/math';
import type { Vec3 } from '../geometry/math';
import type { TrackStore } from '../model/TrackStore';
import type { SelectionSet } from '../model/SelectionSet';
import type { LabelDef } from '../model/types';
import type { PointCloudFrame } from '../io/pcd';
import { colorForLabel, makeDynamicLines, srgbToLinear } from './shared';
import type { DynamicLines } from './shared';

export type ThreeViewAxis = 'top' | 'front' | 'side';

export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RectEntry {
  id: string;
  rect: ViewRect;
  depth: number;
}

/**
 * Orthographic three-view panel (top / front / side) over the current point
 * cloud, with object outlines and heading ticks. Geometry is shared with the
 * 3D view (wrapped, not copied); the depth window filters points per view.
 */
export class ThreeViewPanel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -1000, 1000);

  readonly group = new THREE.Group();
  private points: THREE.Points | null = null;
  private readonly overlay: DynamicLines;
  private readonly lineBuf: Float32Array;
  private readonly colorBuf: Float32Array;
  private readonly corners = new Float64Array(24);
  private rects: RectEntry[] = [];
  private readonly plainMaterial = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, color: 0x9fd8ff });
  private readonly rgbMaterial = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true });

  maxPoints = 60000;

  constructor(
    readonly axis: ThreeViewAxis,
    private readonly labels: LabelDef[]
  ) {
    this.lineBuf = new Float32Array(65536 * 3);
    this.colorBuf = new Float32Array(65536 * 3);
    this.overlay = makeDynamicLines(65536, { vertexColors: true, depthTest: false });
    this.group.add(this.overlay.object);
    this.scene.add(this.group);
    this.placeCamera();
  }

  /** world -> panel plane coords */
  toPlane(p: Vec3): [number, number] {
    if (this.axis === 'top') return [p.x, p.z];
    if (this.axis === 'front') return [p.x, p.y];
    return [p.z, p.y];
  }

  /** depth value along the view axis */
  depthOf(p: Vec3): number {
    if (this.axis === 'top') return p.y;
    if (this.axis === 'front') return p.z;
    return p.x;
  }

  setCloud(cloud: PointCloudFrame | null, depthMin: number, depthMax: number): void {
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
      this.points = null;
    }
    if (!cloud || cloud.count === 0) return;
    const positions: number[] = [];
    const colors: number[] = [];
    const useRgb = !!cloud.rgb;
    const stride = Math.max(1, Math.ceil(cloud.count / this.maxPoints));
    for (let i = 0; i < cloud.count; i += stride) {
      const p: Vec3 = { x: cloud.positions[i * 3], y: cloud.positions[i * 3 + 1], z: cloud.positions[i * 3 + 2] };
      const depth = this.depthOf(p);
      if (depth < depthMin || depth > depthMax) continue;
      const [px, py] = this.toPlane(p);
      positions.push(px, py, 0);
      if (useRgb) {
        colors.push(
          srgbToLinear(cloud.rgb![i * 3] / 255),
          srgbToLinear(cloud.rgb![i * 3 + 1] / 255),
          srgbToLinear(cloud.rgb![i * 3 + 2] / 255)
        );
      }
    }
    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    let material: THREE.PointsMaterial;
    if (useRgb && colors.length > 0) {
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      material = this.rgbMaterial;
    } else {
      material = this.plainMaterial;
    }
    this.points = new THREE.Points(geometry, material);
    this.group.add(this.points);
  }

  syncFrame(frame: number, store: TrackStore, selection: SelectionSet, preview: InstancePreview | null = null): void {
    let v = 0;
    this.rects = [];
    const color = new THREE.Color();
    for (const id of store.activeTrackIds(frame)) {
      const resolved = store.resolveState(id, frame);
      if (!resolved) continue;
      const state = { ...resolved, ...previewPose(id, resolved.pos, resolved.yaw, preview) };
      boxCorners(state.pos, state.yaw, state.size, this.corners);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      let depth = Infinity;
      for (let i = 0; i < 8; i++) {
        const p: Vec3 = { x: this.corners[i * 3], y: this.corners[i * 3 + 1], z: this.corners[i * 3 + 2] };
        const [px, py] = this.toPlane(p);
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
        depth = Math.min(depth, this.depthOf(p));
      }
      this.rects.push({ id, rect: { x0, y0, x1, y1 }, depth });

      color.set(colorForLabel(this.labels, store.getTrack(id)?.meta.label ?? ''));
      if (selection.has(id)) color.set(0xfff36b);
      const edges: Array<[number, number, number, number]> = [
        [x0, y0, x1, y0],
        [x1, y0, x1, y1],
        [x1, y1, x0, y1],
        [x0, y1, x0, y0],
      ];
      for (const [ax, ay, bx, by] of edges) {
        if (v + 2 > this.lineBuf.length / 3) break;
        this.lineBuf[v * 3] = ax; this.lineBuf[v * 3 + 1] = ay; this.lineBuf[v * 3 + 2] = 0.5;
        this.colorBuf[v * 3] = color.r; this.colorBuf[v * 3 + 1] = color.g; this.colorBuf[v * 3 + 2] = color.b;
        v++;
        this.lineBuf[v * 3] = bx; this.lineBuf[v * 3 + 1] = by; this.lineBuf[v * 3 + 2] = 0.5;
        this.colorBuf[v * 3] = color.r; this.colorBuf[v * 3 + 1] = color.g; this.colorBuf[v * 3 + 2] = color.b;
        v++;
      }
      // heading tick (top view only — yaw is visible in the ground plane)
      if (this.axis === 'top') {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const len = Math.max(x1 - x0, y1 - y0) / 2;
        const dx = Math.cos(state.yaw) * len;
        const dy = -Math.sin(state.yaw) * len;
        this.lineBuf[v * 3] = cx; this.lineBuf[v * 3 + 1] = cy; this.lineBuf[v * 3 + 2] = 0.6;
        this.colorBuf[v * 3] = 1; this.colorBuf[v * 3 + 1] = 1; this.colorBuf[v * 3 + 2] = 1;
        v++;
        this.lineBuf[v * 3] = cx + dx; this.lineBuf[v * 3 + 1] = cy + dy; this.lineBuf[v * 3 + 2] = 0.6;
        this.colorBuf[v * 3] = 1; this.colorBuf[v * 3 + 1] = 1; this.colorBuf[v * 3 + 2] = 1;
        v++;
      }
    }
    this.overlay.update(this.lineBuf, v);
    const attr = this.overlay.object.geometry.getAttribute('color') as THREE.BufferAttribute;
    if (attr) {
      (attr.array as Float32Array).set(this.colorBuf.subarray(0, v * 3));
      attr.needsUpdate = true;
    }
  }

  /** Containment pick (panel coords), nearest center distance wins. */
  pick(px: number, py: number): string | null {
    let best: string | null = null;
    let bestDist = Infinity;
    for (const entry of this.rects) {
      const { x0, y0, x1, y1 } = entry.rect;
      if (px >= x0 && px <= x1 && py >= y0 && py <= y1) {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const dist = Math.hypot(px - cx, py - cy);
        if (dist < bestDist) {
          bestDist = dist;
          best = entry.id;
        }
      }
    }
    return best;
  }

  private viewCenter: Vec3 = { x: 0, y: 0, z: 0 };
  private halfExtent = 45;
  private aspect = 1;

  /** viewport px -> panel plane coords (matches fit(), includes user pan) */
  screenToPlane(px: number, py: number, viewportW: number, viewportH: number): { x: number; y: number } {
    const ndcX = (px / Math.max(1, viewportW)) * 2 - 1;
    const ndcY = -(py / Math.max(1, viewportH)) * 2 + 1;
    const h = this.halfExtent;
    const w = h * this.aspect;
    const c = this.viewCenter;
    const panX = this.userPanX * w;
    const panY = this.userPanY * h;
    if (this.axis === 'top') return { x: c.x + ndcX * w + panX, y: c.z - ndcY * h + panY };
    if (this.axis === 'front') return { x: c.x + ndcX * w + panX, y: c.y + ndcY * h + panY };
    return { x: c.z - ndcX * w + panX, y: c.y + ndcY * h + panY };
  }

  fit(center: Vec3, halfExtent: number, aspect = 1): void {
    this.aspect = Math.max(0.01, aspect);
    const half = halfExtent / this.userZoom;
    const panX = this.userPanX * half * this.aspect;
    const panY = this.userPanY * half;
    this.viewCenter = { ...center };
    this.halfExtent = half;
    // 平移量定义在平面坐标上，基点必须经 toPlane 换算（侧视平面x=世界z，俯视平面y=世界z）
    const [pcx, pcy] = this.toPlane(center);
    // Cloud and outlines are already flattened into panel-plane XY coordinates.
    // Orient that plane consistently with screenToPlane(), rather than looking
    // along world axes at geometry that no longer lives in world coordinates.
    const cx = pcx + panX, cy = pcy + panY;
    this.camera.position.set(cx, cy, this.axis === 'front' ? 500 : -500);
    this.camera.up.set(0, this.axis === 'top' ? -1 : 1, 0);
    this.camera.lookAt(cx, cy, 0);
    this.camera.left = -half * this.aspect; this.camera.right = half * this.aspect;
    this.camera.top = half; this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  zoomBy(factor: number): void {
    this.userZoom = Math.max(0.5, Math.min(20, this.userZoom * factor));
  }

  panByFraction(dnx: number, dny: number): void {
    // dnx/dny 为屏幕位移比例（右/下为正）。各轴平面坐标与屏幕方向的对应不同：
    // top: 平面x=屏幕右, 平面y=屏幕下；front: 平面y=屏幕上；side: 平面x=屏幕左, 平面y=屏幕上。
    // 相机沿平面轴移动 +pan 时画面向该轴正向的反方向滑动，故取负号。
    const sx = this.axis === 'side' ? -1 : 1;
    const sy = this.axis === 'top' ? 1 : -1;
    this.userPanX -= (sx * dnx * 2);
    this.userPanY -= (sy * dny * 2);
  }

  resetUserView(): void { this.userZoom = 1; this.userPanX = 0; this.userPanY = 0; }

  private userZoom = 1;
  private userPanX = 0;
  private userPanY = 0;

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.points) this.points.geometry.dispose();
    this.plainMaterial.dispose();
    this.rgbMaterial.dispose();
    this.overlay.dispose();
  }

  private placeCamera(): void {
    // keep the camera in a fixed far position per axis
    if (this.axis === 'top') {
      this.camera.position.set(0, 500, 0);
      this.camera.up.set(0, 0, -1);
    } else if (this.axis === 'front') {
      this.camera.position.set(0, 0, 500);
      this.camera.up.set(0, 1, 0);
    } else {
      this.camera.position.set(500, 0, 0);
      this.camera.up.set(0, 1, 0);
    }
    this.camera.lookAt(0, 0, 0);
  }
}

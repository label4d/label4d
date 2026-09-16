import * as THREE from 'three';
import { pointInPolygon } from '../geometry/math';
import type { CameraProjector } from '../projection/projection';
import type { BoxProjection } from '../projection/projection';
import type { TrackStore } from '../model/TrackStore';
import type { SelectionSet } from '../model/SelectionSet';
import type { LabelDef } from '../model/types';
import type { PointCloudFrame } from '../io/pcd';
import { BOX_EDGES, colorForLabel, makeDynamicLines, paintBadge, srgbToLinear } from './shared';
import type { DynamicLines } from './shared';

export interface CameraPickResult {
  id: string;
  depth: number;
}

export interface CameraViewOptions {
  showAll: boolean;
  /** project the point cloud onto the image as depth/RGB dots */
  cloudProjection: boolean;
}

interface HullEntry {
  id: string;
  hull: number[]; // top-left-origin pixel coords
  depth: number;
}

interface LabelInfo {
  id: string;
  left: number; // min corner px (image coords)
  top: number; // min corner py (image coords, y down)
  show: boolean; // declutter rule: selected + hovered always; others when showAll
}

/** Pixel-space attribute label: a textured Three.js plane (no DOM overlay). */
class PixelLabel {
  readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: THREE.CanvasTexture;
  private text = '';
  private accent = '';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 64;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.renderOrder = 60;
    this.mesh.frustumCulled = false;
  }

  set(text: string, accent: string): void {
    if (text === this.text && accent === this.accent) return;
    this.text = text;
    this.accent = accent;
    paintBadge(this.canvas, text, accent);
    this.texture.needsUpdate = true;
  }

  /** Top-left anchor in GL pixel coords; scale = screen px per texture px. */
  placeTopLeft(px: number, pyGl: number, scale: number): void {
    this.mesh.position.set(px + (this.canvas.width * scale) / 2, pyGl + (this.canvas.height * scale) / 2, 1);
    this.mesh.scale.set(this.canvas.width * scale, this.canvas.height * scale, 1);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.mesh.material as THREE.MeshBasicMaterial).dispose();
  }
}

/**
 * Camera image view, rendered entirely through one Three.js scene
 * (WebGLRenderer + orthographic pixel-space camera):
 *   camera image → textured plane;
 *   projected 4D objects → 8-corner wireframes + bottom-face fills + heading
 *   ticks (dynamic LineSegments / Mesh) + hull outlines;
 *   point-cloud fusion → THREE.Points;
 *   attribute labels → textured planes (same declutter rule as 3D/BEV badges).
 * Everything on screen is a Three.js object — no canvas2d or DOM drawing.
 * Hulls double as the click/selection surface (point-in-hull, nearest depth).
 */
export class CameraImageView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(0, 1, 1, 0, -100, 100);

  readonly group = new THREE.Group();
  private imageMesh: THREE.Mesh | null = null;
  private cloudPoints: THREE.Points | null = null;
  private cloudMaterial: THREE.PointsMaterial | null = null;

  private readonly hullLines: DynamicLines;
  private readonly hullBuf: Float32Array;
  private readonly hullColors: Float32Array;
  private readonly wireLines: DynamicLines;
  private readonly wireBuf: Float32Array;
  private readonly wireColors: Float32Array;
  private readonly footprintMesh: THREE.Mesh;
  private readonly footprintPositions: Float32Array;
  private readonly footprintColors: Float32Array;
  private readonly footprintMaterial: THREE.MeshBasicMaterial;
  private readonly labelSprites = new Map<string, PixelLabel>();
  private hulls: HullEntry[] = [];
  private projector: CameraProjector | null = null;
  private options: CameraViewOptions = { showAll: false, cloudProjection: true };
  private readonly geomLines: DynamicLines;
  private readonly geomBuf: Float32Array;
  private readonly geomColors: Float32Array;

  maxCloudPoints = 20000;
  labelScale = 0.5; // screen px per label-texture px

  constructor(private readonly labelDefs: LabelDef[]) {
    this.hullBuf = new Float32Array(65536 * 3);
    this.hullColors = new Float32Array(65536 * 3);
    this.wireBuf = new Float32Array(131072 * 3);
    this.wireColors = new Float32Array(131072 * 3);
    this.hullLines = makeDynamicLines(65536, { vertexColors: true, depthTest: false });
    this.wireLines = makeDynamicLines(131072, { vertexColors: true, depthTest: false });
    this.geomBuf = new Float32Array(65536 * 3);
    this.geomColors = new Float32Array(65536 * 3);
    this.geomLines = makeDynamicLines(65536, { vertexColors: true, depthTest: false });
    this.hullLines.object.renderOrder = 20;
    this.wireLines.object.renderOrder = 21;
    this.geomLines.object.renderOrder = 22;
    this.group.add(this.hullLines.object);
    this.group.add(this.wireLines.object);
    this.group.add(this.geomLines.object);

    const maxFootprintVerts = 6144 * 6; // 6144 tracks × 2 triangles
    this.footprintPositions = new Float32Array(maxFootprintVerts * 3);
    this.footprintColors = new Float32Array(maxFootprintVerts * 3);
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.footprintPositions, 3);
    const colAttr = new THREE.BufferAttribute(this.footprintColors, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);
    geo.setDrawRange(0, 0);
    this.footprintMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.28,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this.footprintMesh = new THREE.Mesh(geo, this.footprintMaterial);
    this.footprintMesh.renderOrder = 10;
    this.footprintMesh.frustumCulled = false;
    this.group.add(this.footprintMesh);

    this.scene.add(this.group);
  }

  setOptions(options: Partial<CameraViewOptions>): void {
    this.options = { ...this.options, ...options };
  }

  attachProjector(projector: CameraProjector): void {
    this.projector = projector;
    const { width, height } = projector.config;
    this.camera.left = 0;
    this.camera.right = width;
    this.camera.top = height;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
  }

  setImage(image: ImageBitmap | HTMLImageElement): void {
    const config = this.projector?.config;
    if (!config) return;
    if (this.imageMesh) {
      this.scene.remove(this.imageMesh);
      this.imageMesh.geometry.dispose();
      const material = this.imageMesh.material as THREE.MeshBasicMaterial;
      material.map?.dispose();
      material.dispose();
    }
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true; // required: manual Texture starts at version 0
    // plane in pixel space; flipY'd decode puts PNG top row at +Y (top)
    const geometry = new THREE.PlaneGeometry(config.width, config.height);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    this.imageMesh = new THREE.Mesh(geometry, material);
    this.imageMesh.position.set(config.width / 2, config.height / 2, -1);
    this.imageMesh.renderOrder = -10;
    this.scene.add(this.imageMesh);
  }

  /**
   * Rebuild all Three.js projection objects for the current frame.
   */
  syncFrame(
    frame: number,
    store: TrackStore,
    selection: SelectionSet,
    cloud: PointCloudFrame | null,
    hoverId: string | null = null
  ): void {
    if (!this.projector) return;
    const { width, height } = this.projector.config;
    const toGlY = (py: number) => height - py;
    let hv = 0;
    let wv = 0;
    let fv = 0;
    this.hulls = [];
    const labelInfos: LabelInfo[] = [];
    const color = new THREE.Color();

    for (const id of store.activeTrackIds(frame)) {
      const state = store.resolveState(id, frame);
      if (!state) continue;
      const record = store.getTrack(id);
      const projection: BoxProjection = this.projector.projectBox(state.pos, state.yaw, state.size, frame);
      if (!projection.visible || projection.hull.length < 6) continue;
      this.hulls.push({ id, hull: projection.hull, depth: projection.minDepth });

      color.set(colorForLabel(this.labelDefs, record?.meta.label ?? ''));
      if (selection.has(id)) color.set(0xfff36b);

      // hull outline (mirrors the click/selection surface)
      const n = projection.hull.length / 2;
      for (let i = 0; i < n && hv + 2 <= this.hullBuf.length / 3; i++) {
        const j = (i + 1) % n;
        hv = writeLine(this.hullBuf, this.hullColors, hv, projection.hull[i * 2], toGlY(projection.hull[i * 2 + 1]), projection.hull[j * 2], toGlY(projection.hull[j * 2 + 1]), color);
      }

      // 8-corner wireframe (skip edges with a behind-camera endpoint)
      const px = projection.pixels;
      let minX = Infinity;
      let minY = Infinity;
      for (let c = 0; c < 8; c++) {
        if (projection.cornerDepths[c] > 0) {
          minX = Math.min(minX, px[c * 2]);
          minY = Math.min(minY, px[c * 2 + 1]);
        }
      }
      if (Number.isFinite(minX)) {
        labelInfos.push({
          id,
          left: minX,
          top: minY,
          show: this.options.showAll || selection.has(id) || hoverId === id,
        });
      }
      for (const [a, b] of BOX_EDGES) {
        if (projection.cornerDepths[a] <= 1e-6 || projection.cornerDepths[b] <= 1e-6) continue;
        if (wv + 2 > this.wireBuf.length / 3) break;
        wv = writeLine(this.wireBuf, this.wireColors, wv, px[a * 2], toGlY(px[a * 2 + 1]), px[b * 2], toGlY(px[b * 2 + 1]), color);
      }

      // heading tick: bottom-face center → projected heading point
      if (projection.cornerDepths[0] > 1e-6 && projection.cornerDepths[1] > 1e-6) {
        const cx = state.pos.x + Math.cos(state.yaw) * (state.size.x / 2 + 0.6);
        const cz = state.pos.z + -Math.sin(state.yaw) * (state.size.x / 2 + 0.6);
        const headingPoint = this.projector.projectPoint(
          { x: cx, y: state.pos.y - state.size.y / 2, z: cz },
          frame
        );
        if (headingPoint.valid && wv + 2 <= this.wireBuf.length / 3) {
          const bx = (px[0] + px[1 * 2]) / 2;
          const by = (px[0 * 2 + 1] + px[1 * 2 + 1]) / 2;
          wv = writeLine(this.wireBuf, this.wireColors, wv, bx, toGlY(by), headingPoint.x, toGlY(headingPoint.y), color);
        }
      }

      // bottom-face footprint fill (2 triangles, corners 0..3 = bottom face)
      const bottom = [0, 1, 2, 3];
      if (bottom.every((c) => projection.cornerDepths[c] > 1e-6) && fv + 6 <= this.footprintPositions.length / 3) {
        const quad = bottom.map((c) => [px[c * 2], toGlY(px[c * 2 + 1])] as const);
        for (const tri of [[0, 1, 2], [0, 2, 3]]) {
          for (const ci of tri) {
            this.footprintPositions[fv * 3] = quad[ci][0];
            this.footprintPositions[fv * 3 + 1] = quad[ci][1];
            this.footprintPositions[fv * 3 + 2] = 0.3;
            this.footprintColors[fv * 3] = color.r;
            this.footprintColors[fv * 3 + 1] = color.g;
            this.footprintColors[fv * 3 + 2] = color.b;
            fv++;
          }
        }
      }
    }

    this.hullLines.update(this.hullBuf, hv);
    this.flushColors(this.hullLines, this.hullColors, hv);
    this.wireLines.update(this.wireBuf, wv);
    this.flushColors(this.wireLines, this.wireColors, wv);

    const footprintGeo = this.footprintMesh.geometry;
    (footprintGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (footprintGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    footprintGeo.setDrawRange(0, fv);

    this.syncLabels(labelInfos, store, height);
    this.syncGeometryProjection(store, frame, width, height);
    this.syncCloudProjection(
      this.options.cloudProjection ? cloud : null,
      frame,
      width,
      height
    );
  }

  /** 折线/多边形等静态几何投影到相机图像。 */
  private syncGeometryProjection(store: TrackStore, frame: number, width: number, height: number): void {
    let v = 0;
    const color = new THREE.Color();
    for (const geom of store.geometriesAt(frame)) {
      if (this.options.showAll === false && geom.vertices.length === 0) continue;
      color.set(colorForLabel(this.labelDefs, geom.meta.label));
      const projection = this.projector!.projectVertices(geom.vertices, frame);
      for (let i = 0; i < projection.valid.length - 1; i++) {
        if (!projection.valid[i] || !projection.valid[i + 1]) continue;
        if (v + 2 > this.geomBuf.length / 3) break;
        const xi = projection.pixels[i * 2];
        const yi = height - projection.pixels[i * 2 + 1];
        const xj = projection.pixels[(i + 1) * 2];
        const yj = height - projection.pixels[(i + 1) * 2 + 1];
        this.geomBuf[v * 3] = xi;
        this.geomBuf[v * 3 + 1] = yi;
        this.geomBuf[v * 3 + 2] = 0.6;
        this.geomColors[v * 3] = color.r;
        this.geomColors[v * 3 + 1] = color.g;
        this.geomColors[v * 3 + 2] = color.b;
        v++;
        this.geomBuf[v * 3] = xj;
        this.geomBuf[v * 3 + 1] = yj;
        this.geomBuf[v * 3 + 2] = 0.6;
        this.geomColors[v * 3] = color.r;
        this.geomColors[v * 3 + 1] = color.g;
        this.geomColors[v * 3 + 2] = color.b;
        v++;
      }
    }
    this.geomLines.update(this.geomBuf, v);
    this.flushColors(this.geomLines, this.geomColors, v);
  }

  /**
   * Click/box hit-test in image pixel coords (top-left origin).
   * Nearest-depth hull containing the point wins.
   */
  pick(px: number, py: number): CameraPickResult | null {
    let best: CameraPickResult | null = null;
    for (const entry of this.hulls) {
      if (pointInPolygon(px, py, entry.hull, entry.hull.length / 2)) {
        if (!best || entry.depth < best.depth) best = { id: entry.id, depth: entry.depth };
      }
    }
    return best;
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.imageMesh) {
      this.imageMesh.geometry.dispose();
      (this.imageMesh.material as THREE.MeshBasicMaterial).map?.dispose();
      (this.imageMesh.material as THREE.MeshBasicMaterial).dispose();
    }
    if (this.cloudPoints) {
      this.cloudPoints.geometry.dispose();
    }
    this.cloudMaterial?.dispose();
    this.hullLines.dispose();
    this.wireLines.dispose();
    this.geomLines.dispose();
    this.footprintMesh.geometry.dispose();
    this.footprintMaterial.dispose();
    for (const label of this.labelSprites.values()) label.dispose();
    this.labelSprites.clear();
  }

  // ---- internals ----

  private flushColors(lines: DynamicLines, colors: Float32Array, vertexCount: number): void {
    const attr = lines.object.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (attr) {
      (attr.array as Float32Array).set(colors.subarray(0, vertexCount * 3));
      attr.needsUpdate = true;
    }
  }

  private syncLabels(labelInfos: LabelInfo[], store: TrackStore, height: number): void {
    const wanted = labelInfos.filter((info) => info.show);
    for (const [id, label] of this.labelSprites) {
      if (!wanted.some((info) => info.id === id)) {
        this.group.remove(label.mesh);
        label.dispose();
        this.labelSprites.delete(id);
      }
    }
    for (const info of wanted) {
      const record = store.getTrack(info.id);
      let label = this.labelSprites.get(info.id);
      if (!label) {
        label = new PixelLabel();
        this.labelSprites.set(info.id, label);
        this.group.add(label.mesh);
      }
      const attrEntries = Object.entries(record?.meta.attributes ?? {}).slice(0, 2);
      const attrText = attrEntries.map(([k, v]) => `${k}=${v}`).join(' ');
      const name = `${record?.meta.label ?? ''}·${info.id.slice(-4)}${attrText ? ' ' + attrText : ''}`;
      label.set(name, colorForLabel(this.labelDefs, record?.meta.label ?? ''));
      label.placeTopLeft(info.left, height - info.top + 4, this.labelScale);
    }
  }

  private syncCloudProjection(cloud: PointCloudFrame | null, frame: number, width: number, height: number): void {
    if (!this.projector) return;
    if (this.cloudPoints) {
      this.group.remove(this.cloudPoints);
      this.cloudPoints.geometry.dispose();
      this.cloudPoints = null;
    }
    if (!cloud || cloud.count === 0) return;

    const useRgb = !!cloud.rgb;
    const stride = Math.max(1, Math.ceil(cloud.count / this.maxCloudPoints));
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    const firstPass: Array<[number, number, number, number]> = [];
    for (let i = 0; i < cloud.count; i += stride) {
      const world = { x: cloud.positions[i * 3], y: cloud.positions[i * 3 + 1], z: cloud.positions[i * 3 + 2] };
      const projected = this.projector.projectPoint(world, frame);
      if (!projected.valid) continue;
      if (projected.x < -width * 0.1 || projected.x > width * 1.1) continue;
      if (projected.y < -height * 0.1 || projected.y > height * 1.1) continue;
      firstPass.push([projected.x, height - projected.y, projected.depth, i]);
      if (projected.depth < minDepth) minDepth = projected.depth;
      if (projected.depth > maxDepth) maxDepth = projected.depth;
    }
    for (const [x, y, depth, pointIndex] of firstPass) {
      positions.push(x, y, 0.2);
      if (useRgb) {
        color.setRGB(
          srgbToLinear(cloud.rgb![pointIndex * 3] / 255),
          srgbToLinear(cloud.rgb![pointIndex * 3 + 1] / 255),
          srgbToLinear(cloud.rgb![pointIndex * 3 + 2] / 255)
        );
      } else {
        const t = maxDepth > minDepth ? (depth - minDepth) / (maxDepth - minDepth) : 0.5;
        color.setRGB(1 - t, 0.4 + t * 0.4, t);
      }
      colors.push(color.r, color.g, color.b);
    }
    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    if (!this.cloudMaterial) {
      this.cloudMaterial = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, depthTest: false });
    }
    this.cloudPoints = new THREE.Points(geometry, this.cloudMaterial);
    this.cloudPoints.renderOrder = 5;
    this.group.add(this.cloudPoints);
  }
}

function writeLine(
  buf: Float32Array,
  colors: Float32Array,
  index: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: THREE.Color
): number {
  buf[index * 3] = x0;
  buf[index * 3 + 1] = y0;
  buf[index * 3 + 2] = 0.5;
  colors[index * 3] = color.r;
  colors[index * 3 + 1] = color.g;
  colors[index * 3 + 2] = color.b;
  buf[(index + 1) * 3] = x1;
  buf[(index + 1) * 3 + 1] = y1;
  buf[(index + 1) * 3 + 2] = 0.5;
  colors[(index + 1) * 3] = color.r;
  colors[(index + 1) * 3 + 1] = color.g;
  colors[(index + 1) * 3 + 2] = color.b;
  return index + 2;
}

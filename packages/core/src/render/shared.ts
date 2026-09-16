import * as THREE from 'three';
import type { LabelDef } from '../model/types';

/** sRGB (0-1) → linear: sensor RGB fed as vertex colors under sRGB output. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Convert packed RGB bytes (3/point) to linear float colors (3/point). */
export function rgbBytesToLinearColors(rgb: Uint8Array, count: number): Float32Array {
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = srgbToLinear(rgb[i * 3] / 255);
    colors[i * 3 + 1] = srgbToLinear(rgb[i * 3 + 1] / 255);
    colors[i * 3 + 2] = srgbToLinear(rgb[i * 3 + 2] / 255);
  }
  return colors;
}

/** 12 edges of a box over the 8-corner layout used by boxCorners(). */
export const BOX_EDGES: Array<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/** Paints a badge (rounded rect + text) onto a 2d canvas; returns content width. */
export function paintBadge(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  text: string,
  accent: string
): number {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = '600 28px system-ui, sans-serif';
  const width = Math.min(canvas.width, ctx.measureText(text).width + 24);
  ctx.fillStyle = 'rgba(10, 14, 20, 0.78)';
  roundRect(ctx, 2, 14, width, 36, 8);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  roundRect(ctx, 2, 14, width, 36, 8);
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 14, 33);
  return width;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Deterministic label color: palette lookup, hash fallback. */
export function colorForLabel(labels: LabelDef[], label: string): string {
  const def = labels.find((l) => l.name === label);
  if (def) return def.color;
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

export function colorForLabelInt(labels: LabelDef[], label: string): THREE.Color {
  const css = colorForLabel(labels, label);
  return new THREE.Color(css);
}

/** Deep-dispose a subtree: geometries, materials, textures. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const m of material) disposeMaterial(m);
    } else if (material) {
      disposeMaterial(material);
    }
  });
}

function disposeMaterial(material: THREE.Material): void {
  const anyMat = material as THREE.Material & { map?: THREE.Texture | null };
  if (anyMat.map) anyMat.map.dispose();
  material.dispose();
}

export interface DynamicLines {
  object: THREE.LineSegments;
  /** write segments: flat xyz pairs of endpoints; vertexCount = 2 * segments * 3 */
  update(positions: Float32Array, vertexCount: number): void;
  dispose(): void;
}

/** Preallocated line-segments buffer with draw-range updates (no reallocs). */
export function makeDynamicLines(
  capacity: number,
  params: {
    color?: number;
    vertexColors?: boolean;
    opacity?: number;
    depthTest?: boolean;
    /** dashed rendering (虚线预览); distances recomputed per update */
    dashed?: boolean;
    dashSize?: number;
    gapSize?: number;
  } = {}
): DynamicLines {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 3);
  const attr = new THREE.BufferAttribute(positions, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attr);
  let distances: Float32Array | null = null;
  if (params.dashed) {
    distances = new Float32Array(capacity * 3);
    const distAttr = new THREE.BufferAttribute(distances, 1);
    distAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('lineDistance', distAttr);
  }
  if (params.vertexColors) {
    const colors = new Float32Array(capacity * 3);
    const colorAttr = new THREE.BufferAttribute(colors, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', colorAttr);
  }
  const material = params.dashed
    ? new THREE.LineDashedMaterial({
        color: params.color ?? 0xffffff,
        vertexColors: params.vertexColors ?? false,
        transparent: (params.opacity ?? 1) < 1,
        opacity: params.opacity ?? 1,
        depthTest: params.depthTest ?? true,
        dashSize: params.dashSize ?? 0.6,
        gapSize: params.gapSize ?? 0.4,
      })
    : new THREE.LineBasicMaterial({
        color: params.color ?? 0xffffff,
        vertexColors: params.vertexColors ?? false,
        transparent: (params.opacity ?? 1) < 1,
        opacity: params.opacity ?? 1,
        depthTest: params.depthTest ?? true,
      });
  const object = new THREE.LineSegments(geometry, material);
  object.frustumCulled = false;
  return {
    object,
    update(newPositions, vertexCount) {
      const n = Math.min(vertexCount, capacity);
      positions.set(newPositions.subarray(0, n * 3));
      geometry.setDrawRange(0, n);
      (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      if (distances) {
        // each segment restarts: [0, len] per vertex pair
        for (let seg = 0; seg < n; seg += 2) {
          const ax = newPositions[seg * 3];
          const ay = newPositions[seg * 3 + 1];
          const az = newPositions[seg * 3 + 2];
          const bx = newPositions[(seg + 1) * 3];
          const by = newPositions[(seg + 1) * 3 + 1];
          const bz = newPositions[(seg + 1) * 3 + 2];
          const len = Math.hypot(bx - ax, by - ay, bz - az);
          distances[seg] = 0;
          distances[seg + 1] = len;
        }
        (geometry.getAttribute('lineDistance') as THREE.BufferAttribute).needsUpdate = true;
      }
      if (params.vertexColors) {
        (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** Canvas-textured sprite badge for in-view attribute labels. */
export class TextBadge {
  readonly sprite: THREE.Sprite;
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private texture: THREE.CanvasTexture;
  private currentText = '';

  constructor(initialText = '') {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 64;
    const material = new THREE.SpriteMaterial({ map: this.texture = new THREE.CanvasTexture(this.canvas as HTMLCanvasElement), depthTest: false, transparent: true });
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(material);
    this.sprite.renderOrder = 100;
    if (initialText) this.setText(initialText);
  }

  setText(text: string, accent = '#8fd0ff'): void {
    if (text === this.currentText) return;
    this.currentText = text;
    const canvas = this.canvas as HTMLCanvasElement;
    const width = paintBadge(canvas, text, accent);
    this.texture.needsUpdate = true;
    // world-size proportional to pixel aspect
    this.sprite.scale.set(4 * (width / canvas.width), 1, 1);
  }

  dispose(): void {
    this.sprite.material.map?.dispose();
    this.sprite.material.dispose();
  }
}

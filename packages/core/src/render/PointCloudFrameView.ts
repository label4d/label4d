import * as THREE from 'three';
import type { PointCloudFrame } from '../io/pcd';
import { rgbBytesToLinearColors } from './shared';
import { CLOUD_POINT_SIZE, createCloudShaderMaterial } from './cloudShader';

/** Height color ramp: low = blue, mid = green, high = red. */
function heightColor(y: number, min: number, range: number, out: THREE.Color): void {
  const t = range > 1e-6 ? Math.max(0, Math.min(1, (y - min) / range)) : 0.5;
  if (t < 0.5) {
    out.setRGB(0.2 + t * 1.2, 0.45 + t * 0.9, 1.0 - t * 1.6);
  } else {
    const u = (t - 0.5) * 2;
    out.setRGB(0.8 + u * 0.2, 1.0 - u * 0.7, 0.2 - u * 0.18);
  }
}

/**
 * Renders the current point-cloud frame. The FrameBuffer owns raw arrays;
 * this view wraps them in a THREE.BufferGeometry per frame (no copies of
 * position data; colors are computed once per frame swap).
 */
export class PointCloudFrameView {
  readonly group = new THREE.Group();

  private points: THREE.Points | null = null;
  private material: THREE.ShaderMaterial;
  private readonly grid: THREE.GridHelper;
  private currentFrame = -1;
  private frameBuffer: PointCloudFrame | null = null;

  /** Diameter in CSS pixels, shared with Potree. */
  pointSize = CLOUD_POINT_SIZE;

  constructor() {
    this.material = createCloudShaderMaterial({ pointSize: this.pointSize, vertexColors: true });
    this.grid = this.buildBaseGrid(); this.group.add(this.grid);
  }

  get frame(): number {
    return this.currentFrame;
  }

  get loadedFrame(): PointCloudFrame | null {
    return this.frameBuffer;
  }

  setFrame(geo: PointCloudFrame | null, frame: number): void {
    if (!geo || geo.count === 0) {
      if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); this.points = null; }
      this.frameBuffer = null; this.currentFrame = frame; return;
    }
    if (frame === this.currentFrame && geo === this.frameBuffer) return;
    this.currentFrame = frame;
    this.frameBuffer = geo;
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
      this.points = null;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));

    // per-point RGB when the cloud carries color; height ramp otherwise
    let colors: Float32Array;
    if (geo.rgb) {
      colors = rgbBytesToLinearColors(geo.rgb, geo.count);
    } else {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < geo.count; i++) {
        const y = geo.positions[i * 3 + 1];
        if (y < min) min = y;
        if (y > max) max = y;
      }
      colors = new Float32Array(geo.count * 3);
      const color = new THREE.Color();
      for (let i = 0; i < geo.count; i++) {
        heightColor(geo.positions[i * 3 + 1], min, max - min, color);
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
    }
    geometry.setAttribute('pointColor', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = true;
    this.group.add(this.points);
  }

  setPointSize(size: number): void {
    this.pointSize = size;
    this.material.uniforms.uPointSize.value = size;
  }

  dispose(): void {
    if (this.points) {
      this.points.geometry.dispose();
    }
    this.material.dispose(); this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose();
  }

  private buildBaseGrid(): THREE.GridHelper {
    const grid = new THREE.GridHelper(200, 200, 0x224466, 0x16283c);
    grid.position.y = -0.02;
    return grid;
  }
}

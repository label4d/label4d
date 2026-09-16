import * as THREE from 'three';

export interface WorldCloudIndex {
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  cellSize: number;
  overview: { url: string; points: number };
  cells: Array<{ file: string; cx: number; cz: number; points: number }>;
}

/**
 * 全局拼接点云（4D 序列静态环境）的流式渲染：概览层常驻，
 * 按视点距离加载 XZ 网格分块，LRU 控制驻留块数。
 */
export class WorldCloudOverlay {
  readonly group = new THREE.Group();
  private index: WorldCloudIndex | null = null;
  private baseUrl = '';
  private overview: THREE.Points | null = null;
  private cells = new Map<string, { points: THREE.Points; lastUse: number }>();
  private pending = new Set<string>();
  private clock = 0;
  maxCells = 90;
  enabled = false;

  constructor(private fetchBinary: (url: string) => Promise<ArrayBuffer>) {}

  async load(indexUrl: string): Promise<void> {
    this.baseUrl = indexUrl.replace(/index\.json$/, '');
    const index = (await this.fetchJson(indexUrl)) as WorldCloudIndex;
    this.index = index;
    const buf = new Float32Array(await (await this.fetchBinary(this.abs(index.overview.url))).slice(0));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buf, 3));
    const material = new THREE.PointsMaterial({ size: 0.18, color: 0x5b7fa6, sizeAttenuation: true });
    this.overview = new THREE.Points(geometry, material);
    this.group.add(this.overview);
  }

  private abs(url: string): string {
    return this.baseUrl + url.replace(/^world\//, 'world/');
  }

  private fetchJson(url: string): Promise<unknown> {
    return this.fetchBinary(url).then((b) => JSON.parse(new TextDecoder().decode(b)));
  }

  async ensureAround(x: number, z: number, radius: number): Promise<void> {
    if (!this.index || !this.enabled) return;
    this.clock++;
    const { cellSize, cells } = this.index;
    for (const cell of cells) {
      const ccx = (cell.cx + 0.5) * cellSize + this.index.bounds.minX;
      const ccz = (cell.cz + 0.5) * cellSize + this.index.bounds.minZ;
      const dist = Math.hypot(ccx - x, ccz - z);
      const key = `${cell.cx}_${cell.cz}`;
      if (dist <= radius && !this.cells.has(key) && !this.pending.has(key)) {
        this.pending.add(key);
        const file = cell.file;
        this.fetchBinary(this.abs(file))
          .then((buffer) => {
            const positions = new Float32Array(buffer.slice(0));
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const points = new THREE.Points(
              geometry,
              new THREE.PointsMaterial({ size: 0.1, color: 0xbfd8ff, sizeAttenuation: true })
            );
            this.cells.set(key, { points, lastUse: this.clock++ });
            this.group.add(points);
            this.evict();
          })
          .catch(() => undefined)
          .finally(() => this.pending.delete(key));
      }
    }
  }

  private evict(): void {
    if (this.cells.size <= this.maxCells) return;
    const entries = [...this.cells.entries()].sort((a, b) => a[1].lastUse - b[1].lastUse);
    for (const [key, entry] of entries) {
      if (this.cells.size <= this.maxCells) break;
      this.group.remove(entry.points);
      entry.points.geometry.dispose();
      (entry.points.material as THREE.Material).dispose();
      this.cells.delete(key);
    }
  }

  dispose(): void {
    for (const cell of this.cells.values()) {
      cell.points.geometry.dispose();
      (cell.points.material as THREE.Material).dispose();
    }
    this.cells.clear();
    if (this.overview) {
      this.overview.geometry.dispose();
      (this.overview.material as THREE.Material).dispose();
    }
  }
}

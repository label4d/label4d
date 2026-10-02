import * as THREE from 'three';
import { TileScheduler } from '../stream/TileScheduler';
export interface WorldCloudIndex {
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  cellSize: number;
  overview: { url: string; points: number };
  cells: Array<{ file: string; cx: number; cz: number; points: number }>;
}
let nextWorldOverlay = 0;
/** Static cloud cells share the Session scheduler and have one explicit GPU owner. */
export class WorldCloudOverlay {
  readonly group = new THREE.Group();
  private index: WorldCloudIndex | null = null;
  private baseUrl = '';
  private cells = new Map<string, { points: THREE.Points; lastUse: number }>();
  private pending = new Set<string>();
  private desired = new Set<string>();
  private failed = new Set<string>();
  private clock = 0;
  private disposed = false;
  private readonly prefix = `world:${++nextWorldOverlay}:`;
  private readonly scheduler: TileScheduler;
  private readonly ownsScheduler: boolean;
  maxCells = 128;
  enabled = false;
  constructor(private readonly fetchBinary: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>, scheduler?: TileScheduler) {
    this.scheduler = scheduler ?? new TileScheduler({ budgetBytes: 128 * 1024 * 1024 });
    this.ownsScheduler = !scheduler;
  }
  async load(indexUrl: string): Promise<void> {
    this.baseUrl = new URL('.', new URL(indexUrl, typeof location === 'undefined' ? 'http://localhost/' : location.href)).href;
    const index = JSON.parse(new TextDecoder().decode(await this.fetchBinary(indexUrl))) as WorldCloudIndex;
    if (this.disposed) return;
    if (!index.overview || !Array.isArray(index.cells) || !Number.isFinite(index.cellSize) || index.cellSize <= 0) throw new Error('Invalid world cloud index');
    this.index = index;
    const key = `${this.prefix}overview`;
    const overview = await this.request(key, index.overview.url, index.overview.points, true);
    if (!this.disposed && this.scheduler.isResident(key, overview)) this.group.add(overview);
  }
  private abs(url: string): string { return new URL(url.replace(/^world\//, ''), this.baseUrl).href; }
  private request(key: string, url: string, count: number, pinned = false): Promise<THREE.Points> {
    return this.scheduler.request(key, pinned ? 60 : 20, count * 12, async (signal) => {
      const buffer = await this.fetchBinary(this.abs(url), signal);
      if (buffer.byteLength !== count * 12) throw new Error('Invalid world cloud point payload');
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffer), 3));
      return new THREE.Points(geometry, new THREE.PointsMaterial({ size: pinned ? 0.18 : 0.1, color: 0xffffff, sizeAttenuation: true }));
    }, { pinned, bytes: (points) => points.geometry.getAttribute('position').array.byteLength,
      dispose: (points) => {
        this.group.remove(points); points.geometry.dispose(); (points.material as THREE.Material).dispose(); this.cells.delete(key);
      } });
  }
  async ensureAround(x: number, z: number, radius: number): Promise<void> {
    if (!this.index || !this.enabled || this.disposed) return;
    this.clock++; this.desired.clear();
    const { cellSize } = this.index;
    const candidates = this.index.cells.map((cell) => ({ cell, distance: Math.hypot(
      (cell.cx + 0.5) * cellSize + this.index!.bounds.minX - x,
      (cell.cz + 0.5) * cellSize + this.index!.bounds.minZ - z) }))
      .filter((entry) => entry.distance <= radius).sort((a, b) => a.distance - b.distance).slice(0, this.maxCells);
    for (const { cell } of candidates) {
      const key = `${this.prefix}${cell.cx}_${cell.cz}`;
      this.desired.add(key);
      const existing = this.cells.get(key);
      if (existing) { existing.lastUse = this.clock; this.scheduler.touch(key); continue; }
      if (this.pending.has(key) || this.failed.has(key)) continue;
      this.pending.add(key);
      void this.request(key, cell.file, cell.points).then((points) => {
        if (this.disposed || !this.desired.has(key) || !this.scheduler.isResident(key, points)) { this.scheduler.release(key); return; }
        this.cells.set(key, { points, lastUse: this.clock }); this.group.add(points);
      }).catch((error) => { if (error?.name !== 'AbortError') this.failed.add(key); }).finally(() => this.pending.delete(key));
    }
    for (const key of new Set([...this.cells.keys(), ...this.pending])) if (!this.desired.has(key)) this.scheduler.cancel(key);
  }
  dispose(): void {
    this.disposed = true;
    for (const key of new Set([...this.cells.keys(), ...this.pending, `${this.prefix}overview`])) this.scheduler.cancel(key);
    this.cells.clear(); this.desired.clear();
    if (this.ownsScheduler) this.scheduler.dispose();
  }
}

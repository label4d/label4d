import { bilinear, clamp } from '../geometry/math';
import type { TilesetConfig } from '../io/manifest';
import { BevPyramid } from './BevPyramid';
import type { TileScheduler } from './TileScheduler';

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type ImageFetcher = (url: string, signal?: AbortSignal) => Promise<ImageBitmap | HTMLImageElement>;
export type ImageDecoder = (image: ImageBitmap | HTMLImageElement) => RgbaImage | null;

/**
 * Height maps are packed into RGBA PNGs with a canvas-safe 24-bit fixed
 * point scheme: value = round((h + 1000) * 100) stored in R|G|B
 * (little-endian), alpha = 255. Precision 1 cm, range ±10 km.
 * Canvas getImageData never premultiplies this away (unlike float32 bytes
 * whose top byte can be 0).
 */
export function decodePackedHeights(image: RgbaImage): Float32Array {
  const n = image.width * image.height;
  const out = new Float32Array(n);
  const d = image.data;
  for (let i = 0; i < n; i++) {
    const v = d[i * 4] + (d[i * 4 + 1] << 8) + (d[i * 4 + 2] << 16);
    out[i] = d[i * 4 + 3] === 0 ? NaN : v / 100 - 1000;
  }
  return out;
}

export function encodeHeightsToRGBA(heights: Float32Array): Uint8Array {
  const out = new Uint8Array(heights.length * 4);
  for (let i = 0; i < heights.length; i++) {
    const v = Math.max(0, Math.min(16777215, Math.round((heights[i] + 1000) * 100)));
    out[i * 4] = v & 255;
    out[i * 4 + 1] = (v >> 8) & 255;
    out[i * 4 + 2] = (v >> 16) & 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

interface TileData {
  values: Float32Array;
  width: number;
  height: number;
}

/**
 * Tiled height field with bilinear sampling. Drawing tools use sampleSync
 * after prefetchAround() has warmed tiles; missing tiles resolve to 0.
 */
export type HeightSample = { status: 'ready'; value: number; resolution: number } | { status: 'loading' | 'missing' | 'error' };
let nextHeightField = 0;
export class HeightField {
  private pyramid: BevPyramid;
  private tiles = new Map<string, TileData>();
  private pending = new Map<string, Promise<void>>();
  private failures = new Set<string>();
  private disposed = false;
  private readonly prefix = `height${++nextHeightField}`;
  private readonly offEvict: () => void;

  constructor(
    config: TilesetConfig,
    private scheduler: TileScheduler,
    private fetchImage: ImageFetcher,
    private decodeImage: ImageDecoder
  ) {
    this.pyramid = new BevPyramid(config);
    this.offEvict = scheduler.events.on('evicted', ({ id }) => this.tiles.delete(id));
  }

  get maxLevel(): number {
    return this.pyramid.maxLevel;
  }

  tileId(level: number, x: number, y: number): string {
    return `${this.prefix}:${level}:${x}:${y}`;
  }

  /** Warm the finest available tiles around a world position. */
  prefetchAround(x: number, z: number): void {
    for (let level = this.pyramid.maxLevel; level >= Math.max(0, this.pyramid.maxLevel - 2); level--) {
      const coord = this.tileCoordAt(level, x, z);
      if (coord) this.requestTile(level, coord.x, coord.y);
    }
  }

  /** Synchronous sample; falls back to coarser loaded tiles, else 0. */
  sampleState(x: number, z: number): HeightSample {
    for (let level = this.pyramid.maxLevel; level >= 0; level--) {
      const coord = this.tileCoordAt(level, x, z);
      if (!coord) continue;
      const tile = this.tiles.get(this.tileId(level, coord.x, coord.y));
      if (!tile) continue;
      const s = Math.pow(2, this.pyramid.maxLevel - level);
      const px = (x - this.pyramid.config.originX) / (this.pyramid.config.metersPerPixel * s) - coord.x * this.pyramid.config.tileSize;
      const py = (z - this.pyramid.config.originZ) / (this.pyramid.config.metersPerPixel * s) - coord.y * this.pyramid.config.tileSize;
      const value = bilinear(tile.values, tile.width, tile.height, px, py);
      return Number.isFinite(value) ? { status: 'ready', value, resolution: this.pyramid.config.metersPerPixel * s } : { status: 'missing' };
    }
    const coord = this.tileCoordAt(this.pyramid.maxLevel, x, z);
    if (!coord) return { status: 'missing' };
    const id = this.tileId(this.pyramid.maxLevel, coord.x, coord.y);
    return { status: this.failures.has(id) ? 'error' : this.pending.has(id) ? 'loading' : 'missing' };
  }

  sampleSync(x: number, z: number): number | null {
    const sample = this.sampleState(x, z); return sample.status === 'ready' ? sample.value : null;
  }

  /** Async variant that awaits the finest tile when not yet loaded. */
  async sample(x: number, z: number): Promise<number | null> {
    const coord = this.tileCoordAt(this.pyramid.maxLevel, x, z);
    if (coord) {
      await this.requestTile(this.pyramid.maxLevel, coord.x, coord.y).catch(() => undefined);
    }
    return this.sampleSync(x, z);
  }

  get loadedTileCount(): number {
    return this.tiles.size;
  }

  dispose(): void {
    this.disposed = true; this.offEvict();
    for (const id of new Set([...this.tiles.keys(), ...this.pending.keys()])) this.scheduler.cancel(id);
    this.tiles.clear(); this.pending.clear(); this.failures.clear();
  }

  private tileCoordAt(level: number, x: number, z: number): { x: number; y: number } | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const fullX = (x - this.pyramid.config.originX) / this.pyramid.config.metersPerPixel;
    const fullZ = (z - this.pyramid.config.originZ) / this.pyramid.config.metersPerPixel;
    if (fullX < 0 || fullZ < 0 || fullX >= this.pyramid.config.width || fullZ >= this.pyramid.config.height) return null;
    const grid = this.pyramid.tileGridAt(level);
    const s = Math.pow(2, this.pyramid.maxLevel - level);
    const mpp = this.pyramid.config.metersPerPixel * s;
    const px = Math.floor((x - this.pyramid.config.originX) / mpp);
    const py = Math.floor((z - this.pyramid.config.originZ) / mpp);
    const ts = this.pyramid.config.tileSize;
    if (px < 0 || py < 0 || px >= grid.nx * ts || py >= grid.ny * ts) return null;
    return { x: clamp(Math.floor(px / ts), 0, grid.nx - 1), y: clamp(Math.floor(py / ts), 0, grid.ny - 1) };
  }

  private requestTile(level: number, x: number, y: number): Promise<void> {
    const id = this.tileId(level, x, y);
    if (this.disposed || this.tiles.has(id) || this.failures.has(id)) return Promise.resolve();
    const existing = this.pending.get(id); if (existing) return existing;
    const promise = this.scheduler.request<TileData>(id, 90, this.pyramid.tileBytesEstimate(), async (signal) => {
      const image = await this.fetchImage(this.pyramid.tileUrl(level, x, y), signal);
      try {
        const rgba = this.decodeImage(image);
        if (!rgba) throw new Error('Cannot decode height image');
        return { values: decodePackedHeights(rgba), width: rgba.width, height: rgba.height };
      } finally { if ('close' in image) image.close(); }
    }, { bytes: (tile) => tile.values.byteLength })
      .then((tile) => {
        if (this.disposed || !this.scheduler.isResident(id, tile)) { this.scheduler.release(id); return; }
        this.tiles.set(id, tile);
      }).catch((error) => { if (error?.name !== 'AbortError' && !this.disposed) this.failures.add(id); })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, promise); return promise;
  }
}

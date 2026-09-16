import { bilinear, clamp } from '../geometry/math';
import type { TilesetConfig } from '../io/manifest';
import { BevPyramid } from './BevPyramid';
import type { TileScheduler } from './TileScheduler';

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type ImageFetcher = (url: string) => Promise<ImageBitmap | HTMLImageElement>;
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
    out[i] = v / 100 - 1000;
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
export class HeightField {
  private pyramid: BevPyramid;
  private tiles = new Map<string, TileData>();
  private pending = new Set<string>();

  constructor(
    config: TilesetConfig,
    private scheduler: TileScheduler,
    private fetchImage: ImageFetcher,
    private decodeImage: ImageDecoder
  ) {
    this.pyramid = new BevPyramid(config);
  }

  get maxLevel(): number {
    return this.pyramid.maxLevel;
  }

  tileId(level: number, x: number, y: number): string {
    return `height:${level}:${x}:${y}`;
  }

  /** Warm the finest available tiles around a world position. */
  prefetchAround(x: number, z: number): void {
    for (let level = this.pyramid.maxLevel; level >= Math.max(0, this.pyramid.maxLevel - 2); level--) {
      const coord = this.tileCoordAt(level, x, z);
      if (coord) this.requestTile(level, coord.x, coord.y);
    }
  }

  /** Synchronous sample; falls back to coarser loaded tiles, else 0. */
  sampleSync(x: number, z: number): number {
    for (let level = this.pyramid.maxLevel; level >= 0; level--) {
      const coord = this.tileCoordAt(level, x, z);
      if (!coord) continue;
      const tile = this.tiles.get(this.tileId(level, coord.x, coord.y));
      if (!tile) continue;
      const s = Math.pow(2, this.pyramid.maxLevel - level);
      const px = (x - this.pyramid.config.originX) / (this.pyramid.config.metersPerPixel * s) - coord.x * this.pyramid.config.tileSize;
      const py = (z - this.pyramid.config.originZ) / (this.pyramid.config.metersPerPixel * s) - coord.y * this.pyramid.config.tileSize;
      return bilinear(tile.values, tile.width, tile.height, px, py);
    }
    return 0;
  }

  /** Async variant that awaits the finest tile when not yet loaded. */
  async sample(x: number, z: number): Promise<number> {
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
    this.tiles.clear();
    this.pending.clear();
  }

  private tileCoordAt(level: number, x: number, z: number): { x: number; y: number } | null {
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
    if (this.tiles.has(id) || this.pending.has(id)) return Promise.resolve();
    this.pending.add(id);
    const url = this.pyramid.tileUrl(level, x, y);
    const estimate = this.pyramid.tileBytesEstimate();
    const decodeImage = this.decodeImage;
    const fetchImage = this.fetchImage;
    return this.scheduler
      .request<ImageBitmap | HTMLImageElement>(id, -2, estimate, () => fetchImage(url))
      .then((image) => {
        const rgba = decodeImage(image);
        this.pending.delete(id);
        if (!rgba) return;
        this.tiles.set(id, {
          values: decodePackedHeights(rgba),
          width: rgba.width,
          height: rgba.height,
        });
      })
      .catch(() => {
        this.pending.delete(id);
      });
  }
}

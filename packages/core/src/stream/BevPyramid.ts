import { clamp } from '../geometry/math';
import { substituteFrame } from '../io/manifest';
import type { TilesetConfig } from '../io/manifest';

export interface TileCoord {
  level: number;
  x: number;
  y: number;
}

export interface WorldRect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function levelCount(config: TilesetConfig): number {
  const maxDim = Math.max(config.width, config.height);
  return Math.max(1, Math.ceil(Math.log2(maxDim / config.tileSize)) + 1);
}

/**
 * Quadtree pyramid over a ground-plane image. Level `maxLevel` is full
 * resolution; each coarser level halves pixel density. Image +y maps to +z,
 * +x maps to +x (matches BEV texture plane placement).
 */
export class BevPyramid {
  readonly maxLevel: number;

  constructor(readonly config: TilesetConfig) {
    this.maxLevel = levelCount(config) - 1;
  }

  /** world meters per pixel at a level */
  mppAt(level: number): number {
    return this.config.metersPerPixel * Math.pow(2, this.maxLevel - level);
  }

  tilePixelSize(level: number): { width: number; height: number } {
    const s = Math.pow(2, this.maxLevel - level);
    return {
      width: Math.ceil(this.config.width / s),
      height: Math.ceil(this.config.height / s),
    };
  }

  tileGridAt(level: number): { nx: number; ny: number } {
    const dims = this.tilePixelSize(level);
    return {
      nx: Math.ceil(dims.width / this.config.tileSize),
      ny: Math.ceil(dims.height / this.config.tileSize),
    };
  }

  /** level whose pixel density best matches the requested screen density */
  levelForMpp(targetMpp: number): number {
    // coarse targets (large mpp) map to low levels; finest level matches base mpp
    const steps = clamp(Math.round(Math.log2(targetMpp / this.config.metersPerPixel)), 0, this.maxLevel);
    return this.maxLevel - steps;
  }

  tilesForRect(rect: WorldRect, level: number): TileCoord[] {
    const s = Math.pow(2, this.maxLevel - level);
    const px0 = (rect.minX - this.config.originX) / (this.config.metersPerPixel * s);
    const px1 = (rect.maxX - this.config.originX) / (this.config.metersPerPixel * s);
    const py0 = (rect.minZ - this.config.originZ) / (this.config.metersPerPixel * s);
    const py1 = (rect.maxZ - this.config.originZ) / (this.config.metersPerPixel * s);
    const grid = this.tileGridAt(level);
    const ts = this.config.tileSize;
    const x0 = clamp(Math.floor(px0 / ts), 0, grid.nx - 1);
    const x1 = clamp(Math.ceil(px1 / ts) - 1, 0, grid.nx - 1);
    const y0 = clamp(Math.floor(py0 / ts), 0, grid.ny - 1);
    const y1 = clamp(Math.ceil(py1 / ts) - 1, 0, grid.ny - 1);
    const out: TileCoord[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) out.push({ level, x, y });
    }
    return out;
  }

  tileWorldRect(level: number, x: number, y: number): WorldRect {
    const s = Math.pow(2, this.maxLevel - level);
    const size = this.config.tileSize * s * this.config.metersPerPixel;
    return {
      minX: this.config.originX + x * size,
      minZ: this.config.originZ + y * size,
      maxX: this.config.originX + (x + 1) * size,
      maxZ: this.config.originZ + (y + 1) * size,
    };
  }

  tileUrl(level: number, x: number, y: number): string {
    return substituteFrame(
      this.config.urlTemplate
        .replace(/\{level\}/g, String(level))
        .replace(/\{x\}/g, String(x))
        .replace(/\{y\}/g, String(y)),
      -1
    );
  }

  tileBytesEstimate(): number {
    return this.config.tileSize * this.config.tileSize * 4;
  }
}

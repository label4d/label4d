#!/usr/bin/env node
/**
 * Generates a BEV ground tile pyramid (+ matching height tiles) from the
 * converted KITTI point clouds, so 模式 A (PNG-BEV 主导) runs on real data:
 *   public/kitti/tiles/{level}/{x}/{y}.bmp    ground raster (24-bit BMP)
 *   public/kitti/heights/{level}/{x}/{y}.bmp  height raster (fixed-point RGB)
 * and patches public/kitti/manifest.json with bev/height tilesets.
 *
 * Raster color: brightness by returns, hue by height. BMP chosen because it
 * encodes with zero dependencies and createImageBitmap decodes it.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const pubDir = process.argv[2] ?? 'apps/web-ui/public/kitti';
const manifest = JSON.parse(readFileSync(join(pubDir, 'manifest.json'), 'utf8'));

// ---- bounds from ego trajectory + lidar range ----
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const p of manifest.egoPoses) {
  minX = Math.min(minX, p[12] - 100);
  maxX = Math.max(maxX, p[12] + 100);
  minZ = Math.min(minZ, p[14] - 100);
  maxZ = Math.max(maxZ, p[14] + 100);
}
const MPP = 0.2;
const TILE = 512;
let width = Math.ceil((maxX - minX) / MPP);
let height = Math.ceil((maxZ - minZ) / MPP);
width = Math.ceil(width / TILE) * TILE;
height = Math.ceil(height / TILE) * TILE;
console.log(`raster ${width}x${height} px @ ${MPP} m/px, origin (${minX.toFixed(0)}, ${minZ.toFixed(0)})`);

const W = width, H = height;
const maxH = new Float32Array(W * H).fill(-Infinity);
const counts = new Uint16Array(W * H);

// ---- accumulate points (every 5th frame, stride 4) ----
const pcdDir = join(pubDir, 'pcd');
const files = readdirSync(pcdDir).filter((f) => f.endsWith('.pcd'));
let used = 0;
for (let i = 0; i < files.length; i += 5) {
  const buf = readFileSync(join(pcdDir, files[i]));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerEnd = new TextDecoder('ascii').decode(buf.subarray(0, 1024)).split(/\r?\n/).reduce((acc, line) => {
    if (acc.found) return acc;
    acc.end += line.length + 1;
    if (/^DATA/i.test(line)) acc.found = true;
    return acc;
  }, { end: 0, found: false }).end;
  const points = Math.floor((buf.byteLength - headerEnd) / 16);
  for (let p = 0; p < points; p += 4) {
    const off = headerEnd + p * 16;
    const x = view.getFloat32(off, true);
    const y = view.getFloat32(off + 4, true);
    const z = view.getFloat32(off + 8, true);
    const px = Math.floor((x - minX) / MPP);
    const py = Math.floor((z - minZ) / MPP);
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const idx = py * W + px;
    if (y > maxH[idx]) maxH[idx] = y;
    counts[idx]++;
  }
  used++;
}
console.log(`accumulated from ${used} frames`);

// ---- BMP writer (24-bit BGR, bottom-up) ----
function writeBmp(path, w, h, rgba) {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const fileSize = 54 + stride * h;
  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  for (let row = 0; row < h; row++) {
    const srcRow = h - 1 - row; // bottom-up
    for (let col = 0; col < w; col++) {
      const s = (srcRow * w + col) * 4;
      const d = 54 + row * stride + col * 3;
      buf[d] = rgba[s + 2];
      buf[d + 1] = rgba[s + 1];
      buf[d + 2] = rgba[s];
    }
  }
  writeFileSync(path, buf);
}

// ---- color + height rasters ----
const ground = Buffer.alloc(W * H * 4);
const heightRgba = Buffer.alloc(W * H * 4);
let hMin = Infinity, hMax = -Infinity;
for (let i = 0; i < W * H; i++) {
  if (counts[i] > 0 && maxH[i] > hMax) hMax = maxH[i];
  if (counts[i] > 0 && maxH[i] > -Infinity && maxH[i] < hMin) hMin = maxH[i];
}
for (let i = 0; i < W * H; i++) {
  const c = counts[i];
  const h = counts[i] > 0 && maxH[i] > -Infinity ? maxH[i] : 0;
  // ground color: asphalt base, brightness by returns, green tint by height
  const b = Math.min(210, 26 + Math.min(c, 24) * 9);
  const hTint = hMax > hMin ? Math.max(0, Math.min(1, (h - hMin) / (hMax - hMin))) : 0;
  ground[i * 4] = Math.min(255, b * 0.55 + hTint * 30);
  ground[i * 4 + 1] = Math.min(255, b + hTint * 60);
  ground[i * 4 + 2] = Math.min(255, b * 1.1 + 20);
  ground[i * 4 + 3] = 255;
  // height raster: fixed-point RGB scheme (matches HeightField.decodePackedHeights)
  const v = Math.max(0, Math.min(16777215, Math.round((h + 1000) * 100)));
  heightRgba[i * 4] = v & 255;
  heightRgba[i * 4 + 1] = (v >> 8) & 255;
  heightRgba[i * 4 + 2] = (v >> 16) & 255;
  heightRgba[i * 4 + 3] = 255;
}

// ---- cut pyramid (level 0 = coarsest 1 tile, matching BevPyramid) ----
const maxLevel = Math.max(0, Math.round(Math.log2(Math.max(W, H) / TILE)));
function writeTiles(rgba, tag) {
  for (let level = 0; level <= maxLevel; level++) {
    const s = 2 ** (maxLevel - level);
    const lw = Math.ceil(W / s);
    const lh = Math.ceil(H / s);
    const nx = Math.ceil(lw / TILE);
    const ny = Math.ceil(lh / TILE);
    for (let ty = 0; ty < ny; ty++) {
      for (let tx = 0; tx < nx; tx++) {
        const tile = Buffer.alloc(TILE * TILE * 4);
        for (let py = 0; py < TILE; py++) {
          const sy = Math.min(lh - 1, ty * TILE + py);
          for (let px = 0; px < TILE; px++) {
            const sx = Math.min(lw - 1, tx * TILE + px);
            const srcI = (sy * lw + sx) * 4;
            const dstI = (py * TILE + px) * 4;
            tile[dstI] = rgba[srcI];
            tile[dstI + 1] = rgba[srcI + 1];
            tile[dstI + 2] = rgba[srcI + 2];
            tile[dstI + 3] = 255;
          }
        }
        const dir = join(pubDir, tag, String(level), String(tx));
        mkdirSync(dir, { recursive: true });
        // file name = {y}.bmp to match urlTemplate {level}/{x}/{y}.bmp
        writeBmp(join(dir, `${ty}.bmp`), TILE, TILE, tile);
      }
    }
    console.log(`${tag} level ${level}: ${nx}x${ny} tiles`);
  }
}
writeTiles(ground, 'tiles');
writeTiles(heightRgba, 'heights');

// ---- patch manifest ----
manifest.bev = {
  tileset: {
    originX: minX,
    originZ: minZ,
    metersPerPixel: MPP,
    width,
    height,
    tileSize: TILE,
    urlTemplate: 'kitti/tiles/{level}/{x}/{y}.bmp',
  },
};
manifest.height = {
  tileset: {
    originX: minX,
    originZ: minZ,
    metersPerPixel: MPP,
    width,
    height,
    tileSize: TILE,
    urlTemplate: 'kitti/heights/{level}/{x}/{y}.bmp',
  },
};
writeFileSync(join(pubDir, 'manifest.json'), JSON.stringify(manifest));
console.log('manifest patched with bev + height tilesets');

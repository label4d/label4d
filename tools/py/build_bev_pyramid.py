#!/usr/bin/env python3
"""离线构建 BEV 四叉树金字塔（底图 PNG + 高度 PNG 瓦片）。

从世界系 PCD 渲染全分辨率 count/hmax 网格，逐级 2x 降采样切块：
  level maxLevel..0，每级 tileSize 固定，格数减半，直至 1x1 概览。
与客户端 BevPyramid.levelCount/tilePixelSize/tileGridAt 严格对齐。

行序契约（flipY 解码链）：
  - 底图瓦片：文件顶行 = originZ（BevTileRenderer 上传链补偿）。
  - 高度瓦片：保存前垂直翻转（文件顶行 = maxZ），使 HeightField.sampleSync
    在 flipY 解码后按 py=(z-originZ)/mpp 取到正确行。
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

HEIGHT_BASE = 1000  # 与 HeightField.decodePackedHeights 一致：(h+1000)*100 -> R|G|B LE


def read_pcd_xyz(path: Path) -> np.ndarray:
    buf = path.read_bytes()
    start = buf.find(b"DATA binary\n") + len(b"DATA binary\n")
    head = buf[: buf.find(b"DATA")].decode("ascii", "replace")
    points = int(next(l.split()[1] for l in head.splitlines() if l.startswith("POINTS")))
    body = np.frombuffer(buf, dtype=np.float32, count=points * 4, offset=start)
    return body.reshape(points, 4)[:, :3].astype(np.float64)


def colorize_tiles(count: np.ndarray, hmax: np.ndarray, out_dir: Path, level: int,
                   tile: int, flipped: bool) -> int:
    """按瓦片切块着色保存。count/hmax 为该级全图行序数组（行0=minZ）。"""
    h, w = count.shape
    mask = count > 0
    hvals = hmax[mask]
    hlo, hhi = (hvals.min(), hvals.max()) if hvals.size else (0.0, 1.0)
    tint = np.zeros((h, w), np.float32)
    tint[mask] = np.clip((hmax[mask] - hlo) / max(hhi - hlo, 1e-6), 0, 1)

    (out_dir / str(level)).mkdir(parents=True, exist_ok=True)
    written = 0
    for ty in range(h // tile):
        for tx in range(w // tile):
            sl = np.s_[ty * tile:(ty + 1) * tile, tx * tile:(tx + 1) * tile]
            m = mask[sl]
            img = np.zeros((tile, tile, 3), np.uint8)
            img[..., 2] = 16
            img[..., 1] = 18
            img[..., 0] = 22
            if m.any():
                c = count[sl]
                b = np.clip(70 + np.minimum(c, 30) * 5, 0, 210)
                t = tint[sl]
                img[..., 0][m] = np.clip(b * 0.7 + t * 45, 0, 255).astype(np.uint8)[m]
                img[..., 1][m] = np.clip(b + t * 70, 0, 255).astype(np.uint8)[m]
                img[..., 2][m] = np.clip(b * 1.05 + 10 + t * 30, 0, 255).astype(np.uint8)[m]
            if flipped:
                img = img[::-1]
            Image.fromarray(img, "RGB").save(out_dir / f"{level}/{tx}_{ty}.png")
            written += 1
    return written


def height_tiles(hmax: np.ndarray, out_dir: Path, level: int, tile: int) -> int:
    """高度瓦片：RGBA 定点 (h+1000)*100 -> R|G|B LE，A=255，保存前翻转。"""
    h, w = hmax.shape
    (out_dir / str(level)).mkdir(parents=True, exist_ok=True)
    written = 0
    for ty in range(h // tile):
        for tx in range(w // tile):
            sl = np.s_[ty * tile:(ty + 1) * tile, tx * tile:(tx + 1) * tile]
            hv = np.clip(np.round((hmax[sl] + HEIGHT_BASE) * 100), 0, 16777215).astype(np.int64)
            rgba = np.zeros((tile, tile, 4), np.uint8)
            rgba[..., 0] = (hv & 255).astype(np.uint8)
            rgba[..., 1] = ((hv >> 8) & 255).astype(np.uint8)
            rgba[..., 2] = ((hv >> 16) & 255).astype(np.uint8)
            rgba[..., 3] = 255
            rgba = rgba[::-1]  # flipY 解码链补偿：文件顶行 = maxZ
            Image.fromarray(rgba, "RGBA").save(out_dir / f"{level}/{tx}_{ty}.png")
            written += 1
    return written


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="包含 pcd/ 的目录")
    ap.add_argument("--output", required=True, help="瓦片输出根目录")
    ap.add_argument("--mpp", type=float, default=0.0625, help="最细层米/像素")
    ap.add_argument("--size", type=int, default=8192, help="最细层全图边长（像素）")
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--pad", type=float, default=20.0, help="点云包围盒外边距（米）")
    args = ap.parse_args()

    in_dir = Path(args.input)
    out_root = Path(args.output)
    files = sorted((in_dir / "pcd").glob("*.pcd"))
    if not files:
        raise SystemExit(f"no pcd files under {args.input}/pcd")

    # 第一遍：包围盒
    minv = np.full(3, np.inf)
    maxv = np.full(3, -np.inf)
    total = 0
    for f in files:
        pts = read_pcd_xyz(f)
        minv = np.minimum(minv, pts.min(axis=0))
        maxv = np.maximum(maxv, pts.max(axis=0))
        total += len(pts)
    print(f"{total} points from {len(files)} frames, bounds {minv.round(1)}..{maxv.round(1)}")

    # 正方形范围，中心对齐点云
    extent = args.size * args.mpp
    cx, cz = (minv[0] + maxv[0]) / 2, (minv[2] + maxv[2]) / 2
    origin_x, origin_z = cx - extent / 2, cz - extent / 2
    print(f"extent {extent} m, origin ({origin_x:.1f}, {origin_z:.1f}); "
          f"x margin {(extent - (maxv[0] - minv[0])) / 2:.1f} m, z margin {(extent - (maxv[2] - minv[2])) / 2:.1f} m")

    # 第二遍：全分辨率 count + hmax（行0=minZ）
    size = args.size
    count = np.zeros(size * size, np.uint32)
    hmax = np.full(size * size, -np.inf, np.float32)
    drop = 0
    for f in files:
        pts = read_pcd_xyz(f)
        px = ((pts[:, 0] - origin_x) / args.mpp).astype(np.int64)
        py = ((pts[:, 2] - origin_z) / args.mpp).astype(np.int64)
        ok = (px >= 0) & (py >= 0) & (px < size) & (py < size)
        drop += int((~ok).sum())
        px, py, pz = px[ok], py[ok], pts[ok, 1]
        flat = py * size + px
        count += np.bincount(flat, minlength=size * size).astype(np.uint32)
        np.maximum.at(hmax, flat, pz.astype(np.float32))
    print(f"rasterized, dropped {drop} out-of-extent points ({drop / max(total, 1) * 100:.2f}%)")
    count = count.reshape(size, size)
    hmax = hmax.reshape(size, size)
    hmax[~np.isfinite(hmax)] = 0.0

    # 逐级切块（maxLevel..0），2x 降采样由全图逐级半采样
    max_level = (size // args.tile - 1).bit_length()  # size/tile=2^k -> maxLevel=k
    cur_count, cur_hmax = count, hmax
    total_map = total_height = 0
    for level in range(max_level, -1, -1):
        dims = size >> (max_level - level)
        assert cur_count.shape == (dims, dims), (level, cur_count.shape, dims)
        map_dir = out_root / "map"
        height_dir = out_root / "height"
        total_map += colorize_tiles(cur_count, cur_hmax, map_dir, level, args.tile, flipped=False)
        total_height += height_tiles(cur_hmax, height_dir, level, args.tile)
        print(f"level {level}: {dims}x{dims}px, {dims // args.tile}x{dims // args.tile} tiles")
        if level > 0:
            cur_count = cur_count.reshape(dims // 2, 2, dims // 2, 2).sum(axis=(1, 3))
            cur_hmax = cur_hmax.reshape(dims // 2, 2, dims // 2, 2).max(axis=(1, 3))

    # manifest：bev.tileset + height.tileset（客户端 BevPyramid/HeightField 瓦片模式）
    mpath = in_dir / "manifest.json"
    m = json.loads(mpath.read_text())
    tileset = {
        "originX": float(origin_x),
        "originZ": float(origin_z),
        "metersPerPixel": args.mpp,
        "width": size,
        "height": size,
        "tileSize": args.tile,
    }
    m["bev"] = {"tileset": {**tileset, "urlTemplate": "kitti/bev/map/{level}/{x}_{y}.png"}}
    m["height"] = {"tileset": {**tileset, "urlTemplate": "kitti/bev/height/{level}/{x}_{y}.png"}}
    mpath.write_text(json.dumps(m, indent=2))

    print(f"done: {total_map} map tiles, {total_height} height tiles, maxLevel {max_level}")
    print("manifest bev/height switched to pyramid tileset")


if __name__ == "__main__":
    main()

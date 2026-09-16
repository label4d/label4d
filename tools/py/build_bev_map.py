#!/usr/bin/env python3
"""离线生成单张固定尺寸 BEV 地图 + 高度图（图片模式，比点云省资源）。"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def read_pcd_xyz(path: Path) -> np.ndarray:
    buf = path.read_bytes()
    start = buf.find(b"DATA binary\n") + len(b"DATA binary\n")
    head = buf[: buf.find(b"DATA")].decode("ascii", "replace")
    points = int(next(l.split()[1] for l in head.splitlines() if l.startswith("POINTS")))
    body = np.frombuffer(buf, dtype=np.float32, count=points * 4, offset=start)
    return body.reshape(points, 4)[:, :3].copy()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--mpp", type=float, default=0.25)
    ap.add_argument("--size", type=int, default=2048)
    args = ap.parse_args()

    in_dir = Path(args.input)
    files = sorted((in_dir / "pcd").glob("*.pcd"))
    chunks, minv, maxv = [], np.full(3, np.inf), np.full(3, -np.inf)
    for f in files:
        pts = read_pcd_xyz(f)
        chunks.append(pts)
        minv = np.minimum(minv, pts.min(axis=0)); maxv = np.maximum(maxv, pts.max(axis=0))
    cloud = np.concatenate(chunks)

    pad = 110.0
    x_lo, z_lo = cloud[:, 0].min() - pad, cloud[:, 2].min() - pad
    mpp = args.mpp
    px = ((cloud[:, 0] - x_lo) / mpp).astype(np.int32)
    py = ((cloud[:, 2] - z_lo) / mpp).astype(np.int32)
    pz = cloud[:, 1]
    ok = (px >= 0) & (py >= 0) & (px < args.size) & (py < args.size)
    px, py, pz = px[ok], py[ok], pz[ok]
    flat = py.astype(np.int64) * args.size + px

    count = np.bincount(flat, minlength=args.size * args.size)
    hmax = np.full(args.size * args.size, -np.inf)
    np.maximum.at(hmax, flat, pz)
    hmax = hmax.reshape(args.size, args.size)
    mask = count.reshape(args.size, args.size) > 0

    hvals = hmax[mask]
    hlo, hhi = hvals.min(), hvals.max()
    tint = np.zeros(args.size * args.size)
    m2 = mask.ravel()
    tint[m2] = np.clip((hmax.ravel()[m2] - hlo) / max(hhi - hlo, 1e-6), 0, 1)

    img = np.zeros((args.size, args.size, 3), np.uint8)
    img[..., 2] = 16; img[..., 1] = 18; img[..., 0] = 22
    b = np.clip(70 + np.minimum(count, 30) * 5, 0, 210).ravel()
    for ch, base, tv in ((0, b * 0.7, tint * 45), (1, b, tint * 70), (2, b * 1.05 + 10, tint * 30)):
        img[..., ch][mask] = np.clip(base.ravel() + tv, 0, 255).astype(np.uint8)[mask.ravel()]

    himg = np.zeros((args.size, args.size, 3), np.uint8)
    hv = np.full(args.size * args.size, (0 + 1000) * 100, np.int64)
    hv[flat] = np.clip(np.round((pz + 1000) * 100), 0, 16777215).astype(np.int64)
    himg[..., 0] = (hv & 255).reshape(args.size, args.size).astype(np.uint8)
    himg[..., 1] = ((hv >> 8) & 255).reshape(args.size, args.size).astype(np.uint8)
    himg[..., 2] = ((hv >> 16) & 255).reshape(args.size, args.size).astype(np.uint8)

    (in_dir / "bev").mkdir(parents=True, exist_ok=True)
    Image.fromarray(img[::-1], "RGB").save(in_dir / "bev" / "bev-map.bmp")
    Image.fromarray(himg[::-1], "RGB").save(in_dir / "bev" / "bev-height.bmp")

    mpath = in_dir / "manifest.json"
    m = json.loads(mpath.read_text())
    m["bev"] = {"tileset": {"originX": float(x_lo), "originZ": float(z_lo), "metersPerPixel": mpp,
                             "width": args.size, "height": args.size, "tileSize": args.size,
                             "urlTemplate": "kitti/bev/bev-map.bmp"}}
    m["height"] = {"url": "kitti/bev/bev-height.bmp", "originX": float(x_lo), "originZ": float(z_lo),
                   "metersPerPixel": mpp, "width": args.size, "height": args.size}
    mpath.write_text(json.dumps(m, indent=2))
    print(f"bev map {args.size}x{args.size} @ {mpp} m/px")


if __name__ == "__main__":
    main()

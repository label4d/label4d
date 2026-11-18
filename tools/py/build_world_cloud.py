"""Label4D offline data tooling."""

import argparse
import json
import struct
from pathlib import Path

import numpy as np

CELL = 16            # 米，XZ 分块边长
OVERVIEW_TARGET = 300_000
CELL_CAP = 60_000


def read_binary_pcd_xyz(path: Path) -> np.ndarray:
    """读 binary PCD 的 x/y/z 字段，返回 (N,3) float32。"""
    buf = path.read_bytes()
    marker = b"DATA binary\n"
    start = buf.find(marker) + len(marker)
    head = buf[: buf.find(b"DATA")].decode("ascii", "replace")
    points = int(next(l.split()[1] for l in head.splitlines() if l.startswith("POINTS")))
    body = np.frombuffer(buf, dtype=np.float32, count=points * 4, offset=start)
    return body.reshape(points, 4)[:, :3].copy()


def stitch(input_dir: Path, output_dir: Path) -> None:
    files = sorted((input_dir / "pcd").glob("*.pcd"))
    if not files:
        raise SystemExit(f"no pcd files under {input_dir}/pcd")

    chunks = []
    total = 0
    minv = np.full(3, np.inf)
    maxv = np.full(3, -np.inf)
    for f in files:
        pts = read_binary_pcd_xyz(f)
        pts = pts[np.isfinite(pts).all(axis=1)]
        chunks.append(pts)
        total += len(pts)
        minv = np.minimum(minv, pts.min(axis=0))
        maxv = np.maximum(maxv, pts.max(axis=0))
    cloud = np.concatenate(chunks)
    print(f"merged {total} points from {len(files)} frames")

    # XZ 网格分块
    keys = np.stack([(cloud[:, 0] - minv[0]) // CELL, (cloud[:, 2] - minv[2]) // CELL], axis=1).astype(np.int64)
    order = np.lexsort((keys[:, 1], keys[:, 0]))
    keys_sorted = keys[order]
    cloud_sorted = cloud[order]
    starts = np.r_[0, np.flatnonzero(np.diff(keys_sorted, axis=0).any(axis=1)) + 1, len(keys_sorted)]

    out_cells = join_cells(output_dir)
    index_cells = []
    for i in range(len(starts) - 1):
        sl = slice(starts[i], starts[i + 1])
        cx, cz = keys_sorted[starts[i]]
        pts = cloud_sorted[sl]
        if len(pts) > CELL_CAP:
            pts = pts[:: len(pts) // CELL_CAP + 1]
        rel = f"world/cells/{cx}_{cz}.bin"
        (output_dir / "world" / "cells").mkdir(parents=True, exist_ok=True)
        (output_dir / rel).write_bytes(pts.astype(np.float32).tobytes())
        index_cells.append({"file": rel, "cx": int(cx), "cz": int(cz), "points": len(pts)})

    # 概览稀疏采样
    stride = max(1, total // OVERVIEW_TARGET)
    overview = cloud[::stride]
    (output_dir / "world").mkdir(parents=True, exist_ok=True)
    (output_dir / "world/overview.bin").write_bytes(overview.astype(np.float32).tobytes())

    index = {
        "format": "world-cloud.v1",
        "bounds": {"minX": float(minv[0]), "maxX": float(maxv[0]),
                   "minY": float(minv[1]), "maxY": float(maxv[1]),
                   "minZ": float(minv[2]), "maxZ": float(maxv[2])},
        "cellSize": CELL,
        "overview": {"url": "world/overview.bin", "points": len(overview)},
        "cells": index_cells,
    }
    (output_dir / "world/index.json").write_text(json.dumps(index, indent=2))
    print(f"cells: {len(index_cells)}, overview points: {len(overview)}")


def join_cells(output_dir: Path) -> Path:
    d = output_dir / "world" / "cells"
    d.mkdir(parents=True, exist_ok=True)
    return d


def main() -> None:
    ap = argparse.ArgumentParser(description="拼接逐帧点云为全局分块点云")
    ap.add_argument("--input", required=True, help="包含 pcd/ 子目录的目录")
    ap.add_argument("--output", required=True, help="输出目录（world/ 将写入此处）")
    args = ap.parse_args()
    stitch(Path(args.input), Path(args.output))


if __name__ == "__main__":
    main()

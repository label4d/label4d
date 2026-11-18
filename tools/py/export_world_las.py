#!/usr/bin/env python3
"""合并世界系 PCD 为单个 LAS 1.4 文件（PotreeConverter 输入）。

两遍流式处理，不整载内存：第一遍算包围盒，第二遍边读边写
LAS point format 0 记录（X/Y/Z 定点 int32 + intensity）。
头部布局按 laszip 的读取顺序写（system identifier 32B @26-57 等）。
"""
import argparse
import struct
from pathlib import Path

import numpy as np

SCALE = 0.001  # 1 mm 定点精度
OFFSET = (0.0, 0.0, 0.0)  # 世界坐标数百米量级，int32 容量充裕


def read_pcd_xyz(path: Path) -> np.ndarray:
    buf = path.read_bytes()
    start = buf.find(b"DATA binary\n") + len(b"DATA binary\n")
    head = buf[: buf.find(b"DATA")].decode("ascii", "replace")
    points = int(next(l.split()[1] for l in head.splitlines() if l.startswith("POINTS")))
    body = np.frombuffer(buf, dtype=np.float32, count=points * 4, offset=start)
    return body.reshape(points, 4)  # x y z + 第 4 字段（intensity 等）


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="包含 pcd/ 子目录的目录")
    ap.add_argument("--output", required=True, help="输出 .las 路径")
    args = ap.parse_args()

    files = sorted((Path(args.input) / "pcd").glob("*.pcd"))
    if not files:
        raise SystemExit(f"no pcd files under {args.input}/pcd")

    minv = np.full(3, np.inf)
    maxv = np.full(3, -np.inf)
    total = 0
    for f in files:
        pts = read_pcd_xyz(f)[:, :3]
        pts = pts[np.isfinite(pts).all(axis=1)]
        minv = np.minimum(minv, pts.min(axis=0))
        maxv = np.maximum(maxv, pts.max(axis=0))
        total += len(pts)
    print(f"pass1: {total} points, bounds {minv.round(2)} .. {maxv.round(2)}")

    # 包围盒外扩 1cm：定点舍入（1mm 精度）不会把边界点挤出声明范围
    minv = minv - 0.01
    maxv = maxv + 0.01

    HEADER_SIZE = 375  # LAS 1.4
    header = bytearray(HEADER_SIZE)
    struct.pack_into("<4s", header, 0, b"LASF")
    header[24] = 1  # version major
    header[25] = 4  # version minor
    header[26:58] = b"LAStools".ljust(32)  # system identifier（32 字节 @26-57）
    header[58:90] = b"label4d".ljust(32)  # generating software（32 字节 @58-89）
    struct.pack_into("<H", header, 90, 1)  # creation day
    struct.pack_into("<H", header, 92, 2026)  # creation year
    struct.pack_into("<H", header, 94, HEADER_SIZE)
    struct.pack_into("<I", header, 96, HEADER_SIZE)  # offset to point data
    struct.pack_into("<I", header, 100, 0)  # VLR 数
    header[104] = 0  # point format 0
    struct.pack_into("<H", header, 105, 20)  # record length
    struct.pack_into("<I", header, 107, min(total, 4294967295))  # legacy count
    # by-return 5×u32 @111-130 留零
    # scales @131/139/147, offsets @155/163/171
    # max/min 交错 stride 16：maxX@179 minX@187 maxY@195 minY@203 maxZ@211 minZ@219
    for i in range(3):
        struct.pack_into("<d", header, 131 + 8 * i, SCALE)
        struct.pack_into("<d", header, 155 + 8 * i, OFFSET[i])
        struct.pack_into("<d", header, 179 + 16 * i, float(maxv[i]))
        struct.pack_into("<d", header, 187 + 16 * i, float(minv[i]))
    # 1.3+: start of waveform u64 @227；1.4: start of EVLR @235、ext VLR u32 @243、ext count u64 @247、15×u64 by-return @255-374
    struct.pack_into("<Q", header, 247, total)

    with open(args.output, "wb") as out:
        out.write(header)
        written = 0
        for f in files:
            rec = read_pcd_xyz(f)
            ok = np.isfinite(rec).all(axis=1)
            rec = rec[ok]
            xyz = np.empty((len(rec), 3), dtype=np.int32)
            for i in range(3):
                xyz[:, i] = np.rint((rec[:, i].astype(np.float64) - OFFSET[i]) / SCALE)
            intensity = np.clip(rec[:, 3], 0, 65535).astype(np.uint16) if rec.shape[1] > 3 else np.zeros(len(rec), np.uint16)
            payload = np.empty((len(rec), 20), dtype=np.uint8)
            view = xyz.view(np.uint8).reshape(len(rec), 12)
            payload[:, 0:12] = view
            payload[:, 12:14] = intensity.view(np.uint8).reshape(len(rec), 2)
            payload[:, 14:20] = 0
            out.write(payload.tobytes())
            written += len(rec)
        # 回填实际点数（legacy@107 + 扩展@247）
        out.seek(107)
        out.write(struct.pack("<I", min(written, 4294967295)))
        out.seek(247)
        out.write(struct.pack("<Q", written))
    print(f"pass2: wrote {written} records -> {args.output}")


if __name__ == "__main__":
    main()

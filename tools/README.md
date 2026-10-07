# 数据工具

正式的数据导入和数值计算优先使用 **Python + NumPy**，依赖由 `tools/py/pyproject.toml` 和 `uv.lock` 固定。浏览器负责展示与编辑；数据转换不依赖运行中的前端。

## 导入新的 KITTI tracking 序列

将官方五个 tracking 包解压到同一目录，保留其 `training/` 层级：

```text
/data/kitti/training/
  image_02/0004/000000.png ...
  velodyne/0004/000000.bin ...
  oxts/0004.txt
  calib/0004.txt
  label_02/0004.txt
```

从仓库根目录运行：

```sh
pnpm data:import:kitti \
  --input /data/kitti --sequence 0004 \
  --output apps/web-ui/public/datasets/kitti-0004 \
  --url-prefix /datasets/kitti-0004
```

默认导入全部可用帧；`--frames 100` 导入前 100 帧。图片尺寸从源 PNG 读取，不再固定为 1242×375。序列 ID 默认包含序列编号及输出目录名；也可用 `--id` 显式指定。不同录制或坐标版本要使用不同 ID，避免恢复浏览器中的旧标注。

BEV 默认 `--bev-mpp 0.15`，单图最多 4096×4096，超大范围会明确报错；长距离序列可增大到 `--bev-mpp 0.5` 或更粗，避免过大栅格和 GPU 纹理。

输出包括当前帧世界点云 `pcd/`、相机照片 `images/`、bbox 与轨迹 `snapshot.json`、位姿与标定 `manifest.json`、静态 `potree/`、`bev/map.png` 和来源/点数校验 `alignment-report.json`。打开 `/?manifest=/datasets/kitti-0004/manifest.json` 即可使用。`--url-prefix` 必须对应实际静态文件服务路径。

PotreeConverter 构建见 [构建说明](../third_party/POTREE_BUILD.md)。可用 `--potree-converter /path/to/PotreeConverter` 或 `LABELFASTER_POTREE_CONVERTER` 指定二进制。显式指定 `--skip-potree` 时仅生成当前帧点云、标注、相机和 BEV，manifest 不会声称已有 Potree。

默认使用临时目录保存静态过滤点云和 LAS，中间文件完成后释放。`--work-dir /data/import-work/0004` 可保留中间数据，须为该次导入专用。已有非空输出默认拒绝覆盖；仅重建生成数据时使用 `--overwrite`，此参数不会清除浏览器标注文档。源码与输出应位于不同目录。

## 按需获取官方源数据

不必下载完整的大型 ZIP，可按序列与帧数读取官方 ZIP 字节范围：

```sh
pnpm data:fetch:kitti --sequence 0004 --frames 100 --output /data/kitti-0004-source
pnpm data:import:kitti \
  --input /data/kitti-0004-source --sequence 0004 \
  --output apps/web-ui/public/datasets/kitti-0004 --url-prefix /datasets/kitti-0004
```

下载器校验 ZIP CRC，并以 `source.json` 记录缓存序列身份，拒绝复用另一序列的缓存。帧数不得超过官方序列长度。导入器检查逐帧照片/雷达配对、OXTS 行数、标签几何及帧顺序；不能用 raw drive 照片搭配另一录制的 tracking 标签。历史点重合探测不能替代来源证明。

## 工具入口

| 文件 | 用途 |
| --- | --- |
| `py/import_kitti_tracking.py` | 正式 KITTI 导入：位姿、标定、bbox 朝向、世界点云、动态目标过滤、BEV、LAS、Potree |
| `py/fetch_tracking_source.py` | 官方 tracking 序列下载及缓存 |
| `py/build_tracking_bev.py` | 从静态过滤 PCD 独立重建 BEV；`pnpm data:bev --input <work-dir>/pcd --output <sequence-dir> --mpp 0.15` |
| `py/export_world_las.py` | 世界 PCD → LAS；`pnpm data:export:las --input <work-dir> --output <file.las>` |
| `py/build_world_cloud.py` | 既有世界点云分块工具 |
| `py/build_bev_map.py`、`py/build_bev_pyramid.py` | 历史 BEV/高度图生成工具；正式导入优先使用上面的流程，历史路径默认值需自行配置 |
| `data/kitti-calibration.mjs` | 历史 R-mini 标定辅助；当前正式导入使用 Python 的官方 tracking 标定链 |
| `data/make-bev-tiles.mjs`、`data/probe-kitti-mapping.mjs`、`data/calib-selftest.mjs` | 历史生成/诊断工具，保留兼容，后续新增数值功能采用 Python |
| `data/validate-manifest.mjs` | 历史 v2 fixture schema 验证；当前正式导入输出 v1 Y-up |

`scripts/` 中保留兼容命令及 fixture 调度，不重复实现正式转换逻辑。旧 `scripts/convert-kitti-tracking.mjs` 现在转发 Python 参数，拒绝原来的 raw-drive 混配调用。`pnpm fixtures:camera-preview` 调用相同正式工具，生成 0011 前 200 帧预览。

## 验证与入库

```sh
pnpm test:tools
pnpm test
```

工具测试包含一个独立合成的 0004 两帧输入，验证非固定帧数、图片尺寸、URL、bbox/坐标转换、静态点过滤、缓存身份及覆盖保护；真实 BEV 测试在有本地预览时运行。核心真实 KITTI 测试对照已入库的官方标签、标定和照片哈希。

**工具源码、测试、依赖锁文件和参考标定入 Git；原始数据、下载缓存、生成点云、LAS、Potree 与 BEV 不入 Git。** 建议用户数据输出到 `apps/web-ui/public/datasets/`，该目录已忽略。新数据可以按同样命令重新生成。

目前正式适配器支持 KITTI tracking 的上述布局。其他数据格式应增加 Python 适配器，把同步帧、传感器标定和标签转换到同一个 v1 Y-up 契约，不能仅改扩展名后套用 KITTI 公式。

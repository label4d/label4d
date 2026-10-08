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
| `py/validate_manifest.py` | Fixture JSON Schema 子集及时间单调性验证；`pnpm fixtures:validate` 与预检共用 |

已删除重复的 JS 转换、标定、BEV 生成、配对探测工具及兼容入口，不再维护两套实现。失配的旧 R-mini 生成器也已移除，现有历史 fixture 保留用于契约审计；真实数据导入使用 Python 正式入口。`scripts/` 仅保留 fixture 调度、合成样本生成和工程检查。`pnpm fixtures:camera-preview` 调用正式 Python 工具，生成 0011 前 200 帧预览。

## 验证与入库

```sh
pnpm test:tools
pnpm test
```

工具测试包含一个独立合成的 0004 两帧输入，验证非固定帧数、图片尺寸、URL、bbox/坐标转换、静态点过滤、缓存身份及覆盖保护；真实 BEV 测试在有本地预览时运行。核心真实 KITTI 测试对照已入库的官方标签、标定和照片哈希。

**工具源码、测试、依赖锁文件和参考标定入 Git；原始数据、下载缓存、生成点云、LAS、Potree 与 BEV 不入 Git。** 建议用户数据输出到 `apps/web-ui/public/datasets/`，该目录已忽略。新数据可以按同样命令重新生成。

目前浏览器导入支持 KITTI tracking 的上述布局；Waymo Perception v2.0.1 已有离线规范化适配器。新源不能强行压入 v1：真实时间与完整姿态使用 [规范化离线契约](../docs/normalized-data.md)，浏览器接入留到后续阶段。

## Waymo Perception 离线导入

安装可选 `waymo` extra（PyArrow、JSON Schema）；基础 KITTI 工具不依赖 TensorFlow。使用有真实标签的 training/validation，同一 segment 的五相机、五雷达和双回波：

```text
/data/waymo/validation/
  vehicle_pose/<segment>.parquet
  camera_calibration/<segment>.parquet
  lidar_calibration/<segment>.parquet
  camera_image/<segment>.parquet
  lidar/<segment>.parquet
  lidar_pose/<segment>.parquet
  lidar_box/<segment>.parquet
  lidar_camera_projection/<segment>.parquet
```

可选的 `camera_box`、`camera_to_lidar_box_association`、`lidar_camera_synced_box`、`projected_lidar_box`、`stats` 同样保留目录结构，存在时导入源字段。组件必须按原始参考时间排序；乱序、重复身份、缺帧和传感器集不匹配明确拒绝，不缓存整个大组件后静默配对。

```sh
pnpm data:import:waymo \
  --input /data/waymo --split validation \
  --segment 10203656353524179475_7625_000_7645_000 \
  --output apps/web-ui/public/datasets/waymo-normalized-20 --frames 20
pnpm data:validate:normalized apps/web-ui/public/datasets/waymo-normalized-20
pnpm test:tools:waymo
```

去掉 `--frames` 导入完整片段，使用另一个输出目录。输出必须尚不存在，并且与源目录分离；临时目录中完成生成和校验后才发布，失败不会留下一个可误用的完成目录。源、输出、额外处理副本不入 Git。

输出 `sequence.json`、逐帧完整位姿和框观测、原始 JPEG、世界 PCD、点属性 NPZ、过滤 BEV 和 `import-report.json`。不生成 v1 manifest 或快照，当前浏览器不能直接打开它。PCD/坐标基/BEV 复用 KITTI 的共享实现，Waymo 特有的 Parquet 和 range-image 处理在 `py/adapters/waymo.py`。

独立校验使用可选 `waymo-reference` extra 与 Python 3.11，TensorFlow 只用于官方参考计算：

```sh
uv run --project tools/py --python 3.11 --extra waymo-reference \
  python tools/py/validate_waymo_reference.py \
  --input /data/waymo --output apps/web-ui/public/datasets/waymo-normalized-20 \
  --frames 0 10 19
```

校验器从 Waymo 官方 GitHub 固定 commit 下载三个 SDK 数值源文件，验证固定 SHA256 后执行；框角点只执行原文件中的公开 corner 函数，避免依赖未生成的 protobuf。参考代码保留在临时目录，不复制入库。输出 `reference-report.json`，对照双回波 XYZ、3D 框八角点及原始点到相机像素的索引对应；不宣称已经实现滚动快门计算投影或浏览器显示。该 extra 的 TensorFlow 依赖限 Python <3.14，使用上述 Python 3.11 命令。

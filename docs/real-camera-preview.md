# KITTI 相机、4D 点云与静态地图对齐

执行 `pnpm fixtures:camera-preview`，打开 `/?manifest=/kitti-camera/manifest.json`（或「文件与导出 → KITTI 真实相机序列」）。首次运行按官方 ZIP 字节范围获取 tracking 0011 前 200 帧，下载缓存不入 Git。需 Python、uv 和已构建的 PotreeConverter；见 `third_party/POTREE_BUILD.md`，也可设置 `LABELFASTER_POTREE_CONVERTER`。

正式导入、点云过滤、bbox 转换和 BEV 计算已统一到 `tools/py/`，此预览复用同一套工具。导入新序列的参数、目录布局与命令见 [数据工具说明](../tools/README.md)。

## 来源与序列身份

预览统一使用官方 `data_tracking_image_2.zip`、`data_tracking_velodyne.zip`、`data_tracking_oxts.zip`、`data_tracking_calib.zip` 和 `data_tracking_label_2.zip` 中的 **training/0011**。下载器校验 ZIP CRC，所有资源按同一帧编号配对。

不要把 raw drive 的照片/雷达与另一个 tracking 录制的标签组合。历史 R-mini 存在这种混配，只保留为历史 fixture，不能作为对齐证据。不同录制或坐标版本使用新的序列 ID，避免恢复旧标注。预览 ID 的 `_v2` 后缀只是数据修订名称，manifest 的格式仍为 v1。

## 坐标与展示

- OXTS 旋转角保持弧度；按 KITTI devkit 的固定地球半径及首帧纬度缩放计算 Mercator 位移。世界和自车基统一转换为右手 Y-up `(x,z,-y)`。
- 每帧雷达点经过 `velo → imu → world → Y-up` 转换。4D 点云展示当前呈现帧，目标轨迹随该帧更新。
- cam2 使用官方 `P2 · R_rect · Tr_velo_cam`，包含 `P2` 第四列的全部基线分量。照片已校正，不重复应用畸变。相机实例各自拥有投影矩阵缓存，交替渲染不会串用标定。
- 标注框由 KITTI cam0 校正坐标转换，底面中心改为几何中心。长度沿相机 X 轴，`rotation_y` 对应方向 `(cos(ry), 0, -sin(ry))`；纠正先前误用相机 Z 轴造成的 90° 偏差。自车绿色路径与目标轨迹明确区分。引擎的框只有 yaw，不能保留完整 roll/pitch。
- Potree 从这同一序列的世界点云重新生成，采用 UNCOMPRESSED 格式。静态拼接前排除人工框内点（外扩 0.2 m），避免已标注目标的运动拖影；未标注动态物体仍可能残留。相机投影使用同帧点云，静态地图不投进相机。
- BEV 底图从同一批排除目标框内点的静态点云生成，覆盖完整 XZ 范围，0.15 m/px；图像列向右为 +X，行向下为 +Z。黄色叠加为当前呈现帧雷达点，绿色为自车轨迹与当前位置。底图不写深度，坡道上 Y<0 的标注仍可见。支持跟随自车、手动平移、定位和双向框选。
- 点云与 BEV 默认开启「跟随自车」，播放即跟随。3D 跟随保存相机、观察目标和上方向在自车坐标中的相对位姿；按当前呈现帧完整位姿变换，播放、跳帧、转弯和坡度变化保持相对视角。手动轨道操作会更新相对视角，关闭跟随后恢复自由导航。
- 没有 Potree 配置时复选框禁用；加载状态显示实际绘制点数，不再用勾选状态暗示加载成功。

## 验证方法与范围

从仓库根目录运行：

```sh
pnpm test:tools
pnpm test
pnpm --filter @labelfaster/web-ui exec playwright install chromium
pnpm --filter @labelfaster/web-ui exec playwright test --workers=2
```

浏览器测试启动独立的 4173 测试服务，该端口须空闲。缺少生成资源时真实数据用例会跳过；必须检查测试报告，不能把合成测试样本通过当作真实对齐证明。

已入库的 [官方标定、标签采样和照片哈希](../fixtures/calibration/2011_09_26/README.md) 支持独立参考检查。核心测试比较完整投影矩阵、官方照片字节、多帧人工标签中心/尺寸/朝向以及车辆框内雷达支持度；还检查多相机交替访问的缓存隔离。

浏览器用例检查照片切帧、Potree Range 加载与实际绘制点数、相机投影开关、BEV 底图与当前点、框选、跟随和视图重挂载。3D 跟随回归覆盖播放、跳帧、手动调整后的相对位姿保持。Python 测试检查 BEV 轴向和源点落像素，并使用另一小型合成序列检查通用导入路径。

人工检查应选多个帧，将车辆照片、相机框、3D 点云朝向和 BEV 当前点相互对照，区分当前帧与静态地图。源码测试说明正确性的检查方式，不构成对所有数据和硬件的性能保证。KITTI 原始传感器同步误差、滚动快门和激光扫描运动畸变仍可能导致动态目标边缘偏差。

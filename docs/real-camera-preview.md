# KITTI 相机、4D 点云与静态地图对齐

执行 `pnpm fixtures:camera-preview`，打开 `/?manifest=/kitti-camera/manifest.json`（或「文件与导出 → KITTI 真实相机序列」）。首次运行按官方 ZIP 字节范围获取 tracking 0011 前 200 帧，下载缓存不入 Git。需 Python、uv 和已构建的 PotreeConverter；见 `third_party/POTREE_BUILD.md`，也可设置 `LABELFASTER_POTREE_CONVERTER`。

## 纠正的数据来源

旧版本错误地将 raw drive 0084 的照片、雷达和位姿与 tracking 0011 的标签配对。相同的帧数、点数或自洽的变换不能证明不同录制对应；官方照片的直接比较确认了这次混配。旧 R-mini 不能继续作为 tracking 0011 的对齐验收证据，生成器已加入首帧官方照片哈希检查以阻止重建错误混配。

现在统一使用官方 `data_tracking_image_2.zip`、`data_tracking_velodyne.zip`、`data_tracking_oxts.zip`、`data_tracking_calib.zip` 和 `data_tracking_label_2.zip` 中的 **training/0011**。ZIP CRC 校验解压，所有资源按同一帧编号配对。版本使用新的序列 ID，保留以前文档，避免把不同坐标的旧标注恢复到新数据里。

## 坐标与展示

- OXTS 旋转角保持弧度；按 KITTI devkit 的固定地球半径及首帧纬度缩放计算 Mercator 位移。世界和自车基统一转换为右手 Y-up `(x,z,-y)`。
- 每帧雷达点经过 `velo → imu → world → Y-up` 转换。4D 点云展示当前呈现帧，目标轨迹随该帧更新。
- cam2 使用官方 `P2 · R_rect · Tr_velo_cam`，包含 `P2` 第四列的全部基线分量。照片已校正，不重复应用畸变。相机实例各自拥有投影矩阵缓存，交替渲染不会串用标定。
- 标注框由 KITTI cam0 校正坐标转换，底面中心改为几何中心。长度沿相机 X 轴，`rotation_y` 对应方向 `(cos(ry), 0, -sin(ry))`；纠正先前误用相机 Z 轴造成的 90° 偏差。自车绿色路径与目标轨迹明确区分。引擎的框只有 yaw，不能保留完整 roll/pitch。
- Potree 从这同一序列的世界点云重新生成，采用 UNCOMPRESSED 格式。静态拼接前排除人工框内点（外扩 0.2 m），避免已标注目标的运动拖影；未标注动态物体仍可能残留。相机投影使用同帧点云，静态地图不投进相机。
- 没有 Potree 配置时复选框禁用；加载状态显示实际绘制点数，不再用勾选状态暗示加载成功。

## 验证范围

提交了官方标定、人工标签采样和照片哈希，测试对照完整投影矩阵、源雷达帧、官方照片字节以及多帧人工标签中心/尺寸/朝向。浏览器验证照片切帧、实际 Potree Range 加载及可见点数、投影开关、专注视图重挂载和对象选择；另验证相机交替访问的缓存隔离。截图核对真实车辆与标注框对应。首帧车辆框内雷达点支持度作为回归检查，旧 90° 朝向仅包含约 253 点，修正后约 767 点。

验证结果：98 项核心测试通过；9 项完整浏览器测试通过，朝向修正后再次通过真实相机专项浏览器测试；lint 与生产构建通过。

这不是 v2 领域迁移或完整性能验收，也不声称消除了 KITTI 原始传感器同步误差、滚动快门或激光扫描期间的运动畸变。真实动态目标边缘可与扫描点存在偏差。

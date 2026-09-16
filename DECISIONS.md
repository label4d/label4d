# DECISIONS — 规范冲突与实施决定

按任务书 §2 记录：规范冲突、未定义输入与实施决定。修改业务语义/坐标/格式的条目均列出动机与验收影响，供验收者核对。

## D-01 世界坐标系：接受契约 Z-up，经导入适配器迁移
- 冲突：契约（delivery-contracts §2）规定内部世界系 Z-up 右手、自车 X 前 Y 左；现有实现为 Y-up（`geometry/math.ts` 全部绕 Y 旋转，KITTI 转换器含 AXIS_MAP）。
- 决定：v2 数据格式按契约 Z-up 存储；导入适配器负责旧源转换。核心几何数学改为 Z-up 属于 D1 迁移的一部分，非静默变更（本条即变更记录）。已有 KITTI 产物（Y-up PCD/瓦片）标记为旧版本并重新生成。
- 影响：渲染、投影、快照 v2、S/R-mini 全部按 Z-up 重新验证；v1 数据不可直接加载（提供迁移说明而非兼容加载）。

## D-02 时间：接受 timeUs + 参考时间轴，帧号降级为 UI 索引
- 冲突：现实现以整数帧号 + fps 为时间真值；契约要求 referenceFrames[{frameId, timeUs}] + 半开区间 + 同步容差声明。
- 决定：D1 迁移。插值/速度一律用 timeUs；播放 fps 仅影响呈现节奏。KITTI 10Hz → timeUs = frame * 100000。

## D-03 区间：半开区间迁移
- 现实现闭区间 [s,e]（TrackStore.meta 与序列化均为闭区间）。迁移规则：[s,e] → [s, e+1)；导出按契约输出半开区间；UI 显示首末帧不变。

## D-04 业务身份：持久化 UUID 与内部 slot 分离
- 现实现 `trk_000001` 计数器 ID，跨保存/撤销稳定但不满足 UUID 契约。v2 起 Track/Geometry/文档使用 UUID（crypto.randomUUID，导入时重映射容器身份不改变对象身份）。内部 slot+generation 保留为私有优化，不出现在任何交换格式。

## D-05 快照：新增 labelfaster.document.v2，v1 不做自动兼容加载
- v1（base64 列、frameAttrs）语义与 v2（UUID、半开区间、AttributeStore、reviewLedger）差异实质；按契约"未知/旧版本拒绝并保留原文件，提供显式迁移映射"。提供一次性迁移脚本（Y-up→Z-up、闭→半开、frameAttrs→属性区间），旧文件保留原样。

## D-06 属性：独立 AttributeStore 取代 keyframe-attached 逐帧属性
- 动机：契约要求 object/sensor 作用域 + 时间区间覆盖 + 优先级（时间覆盖→对象基础→default-unknown），keyframe-attached 语义无法表达传感器作用域。
- 影响：删除几何关键帧不再影响属性；KITTI occlusion/truncation 迁移为 sensor 作用域单帧区间 [f,f+1)。

## D-07 nuScenes：M1 保持 BLOCKED
- 契约明确 profile 未定不得声称兼容。现有 `exportNuScenesAnnotations` 保留代码但 UI/文档标注为未验收能力，M1 交付 profile = 自有 JSON。

## D-08 R-mini 组装口径
- 来源：本地 raw_drive.zip（SHA-256 登记于夹具清单后移入 fixtures 目录）；提取 0011 对应的 image_02 + velodyne + oxts + 标定（373 帧 → R-mini 取连续 60s 内子段 200 帧，契约 20–60s）。
- BEV 底图：由同一 R-mini 点云正射投影生成（0.2m/px，Z-up），配准关系由同源构造保证，并在夹具清单声明该事实（不做独立大地配准声明）。
- 参考答案：KITTI tracking 0011 官方标注作为独立几何参考（非产品生成）。

## D-09 观测接口命名
- 按契约实现 `window.__LABELFASTER_TEST__.read(query)`（仅测试构建注入）；现有 `window.__lf` 调试对象保留为开发工具，不用于验收断言。

## D-10 性能预算
- 采用 domain-and-streaming-design §6.2 的 MiB 预算表为初始值（未实测）；目标硬件实测后允许调低配置并记录，不允许调高门槛。

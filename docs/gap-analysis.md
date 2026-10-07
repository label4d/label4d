# M1 差距表（实施 AI 代码审计基线）

> 历史记录：本页中的 JS 转换/BEV 工具已移除，失配的 raw/tracking 组合不能作为对齐证明。当前导入实现和命令见 [数据工具](../tools/README.md)。
日期：2026-09-16。审计对象：commit `40554e4` 的实际代码（非历史声明）。
对照规范：`docs/delivery-contracts.md`、`docs/domain-and-streaming-design.md`、`docs/acceptance-checklist.md`。
状态定义：**已有待验证**（功能存在，按 M1 流程重验）/ **需修改**（存在但不符合契约）/ **缺失**（无实现）/ **缺外部输入**（依赖未到位）/ **M1 范围外**。

## 1. 工作区基线

- 分支 main，HEAD `40554e4`；工作区干净。
- 运行方式：`pnpm install && pnpm dev`（Vite 5，端口 5173/5199）；测试 `pnpm --filter @labelfaster/core test`（vitest，43 用例）；构建 `pnpm -r build`（均于本机通过）。
- 本地资产：`/tmp/kitti4d/raw_drive.zip`（2011_09_26_drive_0084 同步包 1.57GB，含 image_00–03/oxts/velodyne）——**未纳入仓库**，R-mini 需从这里提取相机帧与标定；资产外置符合契约，但需按契约登记 SHA-256 与获取说明。
- 已有数据产物：`apps/web-ui/public/kitti/`（gitignored）：373 帧 PCD（Y-up 世界系）、egoPoses、BEV BMP 瓦片、高度瓦片、KITTI 官方标注快照 v1。**注意：坐标系为旧约定，不满足 Z-up 契约，R-mini 需重新导出。**

## 2. 对照验收清单的逐项差距

| ID | 状态 | 依据（真实文件） | 差距 |
|---|---|---|---|
| ENV-01 | 已有待验证 | `package.json`（root/scripts）、`.gitignore` | 缺 `verify:*` 命令与隔离 profile 约定 |
| DATA-01 | 缺失 | 无 S-mini 夹具；`apps/web-ui/src/lib/demo.ts` 是浏览器内造数据，契约明确不允许替代生产加载管线 | 需 S-mini 生成器（文件型资产 + manifest v2 + 独立答案，不调用产品数学） |
| DATA-02 | 缺外部输入（可补齐） | `/tmp/kitti4d/raw_drive.zip` 有 image_02/oxts/velodyne；旧转换脚本曾验证内部变换，但未证明录制身份 | R-mini 组装脚本未写；相机帧/标定未提取登记；BEV 配准底图现有产物基于旧坐标系 |
| DATA-03 | 需修改 | 世界系为 Y-up（`packages/core/src/geometry/math.ts` composeBoxMatrix 绕 Y；当前 Python 导入的 BASIS） | 契约要求 Z-up 右手、`T_to_from` 列主序、timeUs、像素中心语义；v1 数据需迁移适配器 |
| DOM-01 | 已有待验证 | `packages/core/src/model/TrackStore.ts`（关键帧/插值/区间）、`test/store.test.ts` | 现实现用闭区间；半开区间契约需迁移。插值帧编辑创建关键帧行为已有（`EditorSession.setKeyframeAtCurrentFrame`） |
| DOM-02 | 部分已有 | `interaction/ToolMachine.ts`（一次手势一个意图→一条命令；Esc 取消）、`render/TrackInstanceRenderer.ts`（预览在渲染层） | 无 ChangeSet/影响区间/基准 revision 冲突检测（D2 范围） |
| DOM-03 | 需修改 | `model/TrackStore.ts` frameAttrs（Map<frame, attrs> 挂在轨迹上） | 契约要求独立 AttributeStore（key/scope object·sensor/时间区间覆盖/优先级/default-unknown），当前 keyframe-attached 语义不同 |
| FRAME-01 | 需修改 | `stream/FrameBuffer.ts`（预取窗口+LRU） | 无 requested/presented 分离、无 FrameContext（sampleId/time/版本/epoch）、无晚到拒绝；编辑帧与呈现帧未锁定 |
| VIEW-01 | 已有待验证 | `render/TrackInstanceRenderer.ts`、`CameraImageView.ts`（共享 SelectionSet，rayOBB 修复后点选实测通过） | 投影独立性（相机拾取用产品投影）在 M1 按协议以独立控制点另验 |
| SAVE-01 | 缺失 | 持久化为内存 oplog + 手动导出（`command/History.ts`、`io/snapshot.ts`） | IndexedDB 原子事务/保存状态机/失败语义未实现 |
| SAVE-02 | 缺失 | 同上 | 崩溃恢复/J01-6 重开流程依赖 IndexedDB 落地 |
| SAVE-03 | 缺失 | 无 Web Locks / 租约实现 | 多标签页单写者 |
| REVIEW-01/02 | 缺失 | 仅 `qa.status` 单值（`EditorSession.qa`） | ReviewLedger（对象+场景完整性、区间分段、stale 依赖、交付门禁）整体缺失 |
| EXPORT-01 | 部分已有 | `io/formats.ts` exportNuScenesAnnotations、`io/snapshot.ts` 自有 JSON | 自有 JSON 往返已有测试；缺 v2 格式、独立读取器、草稿/正式门禁；nuScenes 按契约 BLOCKED |
| RESOURCE-01/02 | 需修改 | `stream/TileScheduler.ts`（单账本字节 LRU + release）、`stream/FrameBuffer.ts` | 无 encoded/decoded/gpu 三表示账本、无 lease/pin/预约、无 MiB 预算表、无 upload 队列与 Worker 解码（S1/S2） |
| TEST-01/02 | 部分已有 | `window.__lf`（调试暴露，非契约）；43 个 vitest | 缺 `window.__LABELFASTER_TEST__.read(query)` 只读观测（分组/revision/nonAtomic）、独立导出验证器、故障注入入口 |
| UX-01 | 已有待验证 | 本轮 browser-use 已实测：播放/时间线/点选/属性编辑+撤销/右键菜单/复制轨迹/闪烁/tooltip | 需按 J01 脚本化重跑并入证据包；computer use 独立任务另排 |
| EVIDENCE-01 | 缺失 | 无 artifacts/run 目录约定落地 | 证据包目录结构与 report/metrics 采集未实现 |

## 3. 关键语义冲突（详见 DECISIONS.md）

1. 世界系 Y-up（现实现）vs 契约 Z-up（D-01）：影响全部几何数学、渲染、已有 KITTI 产物。
2. 帧号+fps（现）vs timeUs 参考时间轴 + 半开区间（D-02/D-03）。
3. 字符串计数 ID vs 持久化 UUID 业务身份（D-04）。
4. v1 快照（base64 列）vs `labelfaster.document.v2`（D-05，需迁移映射，旧格式不猜语义）。
5. keyframe-attached 逐帧属性 vs 独立属性区间存储（D-06）。

## 4. R-mini 可用性核查（DATA-02 前置）

| 模态 | 状态 | 来源 |
|---|---|---|
| 点云 | ✅ 373 帧已验证可解析 | raw_drive.zip → velodyne_points |
| 相机 | ✅ zip 内 image_02 373 帧（未提取登记） | 同上 |
| Pose/标定 | ✅ oxts + calib_velo_to_cam/imu_to_velo/cam_to_cam（已实证可用） | 同上 + calib_date |
| BEV 配准底图 | ✅ 可由点云正射投影生成（与点云同源即配准）；旧产物坐标系需重生成 | tools/py/build_tracking_bev.py |
| 参考答案 | ✅ KITTI tracking 0011 官方人工标注（60 轨迹） | labels.zip（已校验解压） |
| 连续时长 | 37.3s（373 帧 @10Hz）✅ 满足 20–60s | — |

结论：R-mini 可完全本地组装，无不可补的外部缺口；需按契约登记校验和与获取说明。

## 5. 本轮（H0）已开始/待办

已开始：差距表（本文）、DECISIONS、manifest v2 schema 与合法/非法样例、S-mini 生成器与独立答案、R-mini 组装脚本、`verify:preflight`。
待办（H1–H4）：v2 领域层迁移（Z-up/timeUs/UUID/半开区间）、AttributeStore/ReviewLedger、IndexedDB 持久化、FrameCoordinator、三阶段资源账本、观测接口、J01 自动化与 F01–F06、独立导出验证器。

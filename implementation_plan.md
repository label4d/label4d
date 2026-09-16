# 实现方案（4D 商业级）

> 架构设计详见 `docs/architecture.md`，需求详见 `requirements.md`。本文只保留迭代路径与验收口径。

## 工作区

- `packages/core`：`@labelfaster/core` — 4D 文档模型（列式 TrackStore）、命令/OpLog、流式调度、投影（针孔/鱼眼注册表）、交互状态机、Three.js 渲染同步层（`src/render/` 为 core 内唯一 three 依赖区）、EditorSession 组合根。
- `apps/web-ui`：React + Tailwind（Vite）。只做视图装配与事件转发：工具栏、时间线、播放条、对象/属性面板、3D 视图、BEV 视图、相机视图、三视图。
- `apps/web-ui/src/lib/demo.ts`：自包含合成序列（demo:// 协议 + 注入式 NetClient），无外部数据即可验证全链路。

## 已落地的能力基线

- 双模式 4D：BEV-PNG 主导（瓦片金字塔 + 高度图）与点云主导（逐帧 PCD 环形窗口），共享同一轨迹模型。
- 轨迹：关键帧 SoA + 线性/最短弧 yaw 插值 + hold、区间索引、拆分/合并/拷贝状态；逐帧属性（occlusion 等）。
- 命令系统：13 类命令 + 事务批量 + OpLog 事件溯源 + 快照 base64 序列化（导入/导出、nuScenes 导出）。
- 投影联动：多相机（针孔/Brown-Conrady、鱼眼等距/等立体角）→ 图像平面 hull 可点选；点云三视图（俯/前/侧）可点选；自车轨迹点可点击跳帧。
- 流式：TileScheduler（优先级/并发/预算/LRU）统一调度点云帧、BEV 瓦片、高度瓦片、Potree 节点（Potree 2 格式适配器，LAZ 解码注入）。
- 模型辅助：AssistAdapter 接口 + 候选批量导入（单步撤销）+ 置信度阈值。

## 迭代路径

1. ✅ 核心模型、命令框架、快照/OpLog（vitest 36 用例）。
2. ✅ 双视口 + 流式调度 + 绘制工具（两段式 3D 框、折线/多边形、顶点编辑、测量）。
3. ✅ 相机投影与点选、三视图、自车轨迹、视图内属性徽标与编辑。
4. 真实数据接入：PotreeConverter 离线管线、libvips 切图脚本、标定文件加载（对接 demo:// 同构的 manifest 即可）。
5. 性能验收：1000 track × 3000 帧压测（切帧 < 100ms、undo < 50ms、10fps 播放），必要时加 dirty 分片与 Worker 解码。
6. 后续：OCam/ATAN 投影模型（注册表已预留）、cubic 插值策略、协同编辑（OpLog 已是事件溯源基础）。

## 测试与质量

- `packages/core`：`pnpm --filter @labelfaster/core test`（vitest run）— store/插值/命令/OpLog 重放/PCD/快照 base64/调度器/帧缓冲/金字塔/投影（含鱼眼与 ego 链路）。
- 全仓：`pnpm -r build`（core: tsup+dts；web-ui: tsc -b + vite build）。
- 手动冒烟：`pnpm dev` → 播放、BEV 画框、相机视图双击改属性、时间线 scrub、undo/redo。

# 实现方案（4D 商业级）

> 架构设计详见 `docs/architecture.md`，需求详见 `requirements.md`。本文只保留迭代路径与验收口径。

> 2026-09-16：领域与资源调度按 `docs/domain-and-streaming-design.md` 更新设计。以下历史能力声明未经本次代码检查；新增设计均待实现与验证，不能按设计完成标记实现完成。

> 交接入口：[文档索引](docs/README.md)。其他 AI 按 [实施任务书](docs/implementation-handoff.md) 与 [接口契约](docs/delivery-contracts.md) 交付；独立验收按 [步骤与清单](docs/acceptance-checklist.md) 执行。第一轮范围为 M1，不能将其通过等同于全需求完成。

## 工作区

- `packages/core`：`@labelfaster/core` — AnnotationDocument（Track、StaticGeometry、AttributeStore、ReviewLedger）、命令/OpLog、三阶段资源调度、FrameCoordinator、投影、交互事务、Three.js 渲染同步层（`src/render/` 为 core 内唯一 three 依赖区）、EditorSession 组合根。Repository 隐藏具体列式布局。
- `apps/web-ui`：React + Tailwind（Vite）。只做视图装配与事件转发：工具栏、时间线、播放条、对象/属性面板、3D 视图、BEV 视图、相机视图、三视图。
- `apps/web-ui/src/lib/demo.ts`：自包含合成序列（demo:// 协议 + 注入式 NetClient），无外部数据即可验证全链路。

## 历史能力基线（原计划声明，待重新验收）

- 双模式 4D：BEV-PNG 主导（瓦片金字塔 + 高度图）与点云主导（逐帧 PCD 环形窗口），共享同一轨迹模型。
- 轨迹：关键帧 SoA + 线性/最短弧 yaw 插值 + hold、区间索引、拆分/合并/拷贝状态；逐帧属性（occlusion 等）。
- 命令系统：13 类命令 + 事务批量 + OpLog 事件溯源 + 快照 base64 序列化（导入/导出、nuScenes 导出）。
- 投影联动：多相机（针孔/Brown-Conrady、鱼眼等距/等立体角）→ 图像平面 hull 可点选；点云三视图（俯/前/侧）可点选；自车轨迹点可点击跳帧。
- 流式：TileScheduler（优先级/并发/预算/LRU）统一调度点云帧、BEV 瓦片、高度瓦片、Potree 节点（Potree 2 格式适配器，LAZ 解码注入）。
- 模型辅助：AssistAdapter 接口 + 候选批量导入（单步撤销）+ 置信度阈值。

## 迭代路径

1. **D1 领域契约与真实样本**：稳定 ID、半开区间迁移、轨迹/静态几何、独立属性区间和 Float64 边界；准备可解析合成数据与真实短序列。验收结构操作前后语义与保存往返。
2. **D2 编辑与复核闭环**：手势事务、ChangeSet、复核内容依赖、持久化后发布；验证拖拽/Esc、影响范围、撤销恢复与提交前后崩溃。串联真实样本从画框到导出。
3. **S1 资源账本**：encoded/decoded/GPU 多表示、CPU/GPU 峰值预约、lease/pin、Provider 体积描述；以假网络和假解码器验证预算与释放不变量。
4. **S2 调度与呈现**：fetch/decode/upload 队列、Worker 所有权、方向性预取、FrameCoordinator、资源不足退让；用浏览器验证快速拖轴、晚到响应、共存不足和当前帧一致性。
5. **S3 规模与交付**：1000 track × 3000 帧，固定并记录点数、相机、关键帧密度及硬件，测 p95/p99、采样帧呈现率、保存延迟、30 分钟资源稳定性。真实数据与性能子集从 D1 起持续运行。
6. **后续扩展**：其他投影模型、cubic、pose 校正及协同分别按实际需求立项；协同还需独立设计冲突、权限、版本及多人 undo，不以已有 OpLog 视为完成。

阶段状态分别记录“设计完成 / 实现待验证 / 自动验证通过 / 真实数据验收通过”，链接数据版本、操作 trace、断言、截图与指标。本次仅更新设计状态。

## 测试与质量

AI 自主验收按 [验收协议](docs/ai-acceptance-protocol.md) 执行：UI 自动化驱动 J01 全链路，独立数据断言判定正确性，computer use 检查视觉与操作；真实与合成夹具分别报告，F01–F06 覆盖失败路径。协议和测试设施当前均未验收，不能将文档存在视为测试通过。

- `packages/core`：`pnpm --filter @labelfaster/core test`（vitest run）— store/插值/命令/OpLog 重放/PCD/快照 base64/调度器/帧缓冲/金字塔/投影（含鱼眼与 ego 链路）。
- 全仓：`pnpm -r build`（core: tsup+dts；web-ui: tsc -b + vite build）。
- 手动冒烟：`pnpm dev` → 播放、BEV 画框、相机视图单击标签改属性、时间线 scrub、undo/redo。实际命令由实施者核验，冒烟不替代正式验收。

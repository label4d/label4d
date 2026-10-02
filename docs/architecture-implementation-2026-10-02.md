# 架构优化实施记录 — 2026-10-02

对应 [实现审计](architecture-audit-2026-10-02.md)，起始代码基线 `83aea5ed05d5adea4fa08e7b977080fbe0517e1a`。本记录随架构优化提交归档；审计报告中的旧行号及复现结果保留为历史证据。

本轮完成现有 **v1 生产管线的正确性修复、帧协调、资源生命周期、可恢复保存和部分计算优化**。没有完成 v2 领域迁移或全部 M1 验收；设计文档仍是目标契约，没有将契约改成当前实现。

## 审计项处理

| 项目 | 已实施 | 当前边界 |
|---|---|---|
| A01 批量日志 | batch 统一 `{ children }`，单事务记录；undo/redo 带动作 | 内存 OpLog 尚无通用历史重放入口；IndexedDB 恢复直接重放捕获的 patch |
| A02 原子性 | TrackStore affected-aggregate journal、staging、patch/inverse；失败回滚、单次发布；订阅异常隔离 | 兼容公开 raw store/history API 尚未全部收口为只读 facade |
| A03 拆分/撤销 | 拆分补解析边界；undo 恢复存在区间；合并限制同类别、兼容元数据、相邻区间并补 hold 边界 | 仍使用 v1 帧号/闭区间 |
| A04 编辑/手势 | 默认移动与旋转设置当前呈现帧关键帧；旋转与预览共用 pivot；开始编辑暂停，换帧取消；BEV 空白绘图恢复；跨视图 preview | 尚无正式 EditScope UI、revision 绑定的完整手势上下文 |
| A05 帧一致性 | requested/presented 分离、epoch 淘汰旧响应；必需点云 ready 后呈现；加载期间禁止编辑、播放等待 | 相机失败作为可选模态清空，不沿用旧图；预算不足显示错误，尚无释放旧呈现组后重新准入策略 |
| A06 多相机 | 每路相机独立 FrameBuffer，视图按 cameraId 取图，null 图清空旧纹理 | 浏览器冒烟使用 demo；真实标定/跨模态精度尚未独立验收 |
| A07 资源所有权 | scheduler 管 queued/running/resident、预约与实际字节、pin、AbortSignal、释放回调；FrameBuffer/高度/BEV/world cloud 接入；generation 防晚到回填 | 此账本不是完整 encoded/decoded/transient/GPU 三阶段账本，不能据此声称显存或 RSS 达标 |
| A08 替换边界 | 序列切换清旧文档/历史/选择/资源；先校验 pose；快照在候选 store 验证再替换；ID 碰撞保护 | v1 dataset ID 是存储键，尚无数据/标定版本 hash |
| A09 高度 | ready/loading/missing/error；等待真实 pending；未知/透明像素无效；用户明确选择零平面才可用 0 | 默认 terrain 不推断未加载高度 |
| A10 保存/复核 | IndexedDB 事务完成后发布；patch/inverse、undo/redo、恢复栈、保存状态和重试；Web Locks + 租约/fencing；修改使 QA pending，精确 undo 恢复 QA | QA 是全局状态，尚非区间 ReviewLedger；无正式导出门禁 |
| A11 v2 脱节 | 运行时明确拒绝 v2，检查轨迹/快照/标定；nuScenes UI 标为草稿 | Z-up/timeUs/UUID/半开区间/Float64/AttributeStore 尚未迁移，v2 S-mini/R-mini 不能直接加载到当前编辑器 |

## 保存恢复实现

`IndexedDbDocumentStorage` 使用 `labelfaster-documents` 数据库版本 2：`documents` 保存 baseline、head revision 和 fenced lease，`edits` 按 `[documentKey, revision]` 分条追加，并以 `[documentKey, operationId]` 唯一索引拒绝重复写入。旧版本把全部 edits 放在 document envelope 内；upgrade 事务迁移旧历史后清空 envelope 的 edits。保存和租约续期不再重写全部操作历史；baseline 仍随文档头写入，后续可进一步分离。

Session 先在不可见 staging 中计算 patch/inverse，等待存储事务完成，再发布领域状态并推进 history。写失败时保留原文档和撤销栈，可重试；恢复先验证 baseline、连续 revision、操作 ID、动作及 patch，再替换当前文档。浏览器 Web Locks 在刷新/崩溃后自动释放；不支持时使用 20 秒租约、每 5 秒续期。每次 append 均校验 fencing token；旧 writer 的 close 不覆盖新 writer 的租约。

未做 checkpoint compaction、日志分页、持久化容量上限或 undo horizon 修剪；恢复仍读取全部日志。不可将当前结构等同于长时间、大规模编辑性能验收。

## 计算、渲染与工程优化

- 覆盖率从逐帧查询改为存在区间合并，按 store revision/frameCount 缓存。
- 相机投影按 frame/store/selection/hover/preview/显隐/options/cloud 缓存，点云投影单独缓存；无点云证据不再默认隐藏已有框。相机、主视图与 BEV 的隐藏类别过滤一致。
- 三视图去掉第一个面板每 rAF 重建点云；cloud/focus/depth 变化驱动更新，focus 未变时保留 pan/zoom。
- 框渲染 preview equality 避免重复失效；缓存包含实际隐藏集合；复用颜色并释放 grow 后旧 geometry/material。仍未实现稳定 slot 的逐对象增量更新。
- 小窗口方向预取替代 ±45；当前和呈现帧 pin；world cloud 接入共用 scheduler 并限制候选数量。
- React SessionProvider 改到 effect 装配并清理；清理视图事件、image/height/blink；开发 hooks 仅 DEV 可用。测试只读 probe 仅 MODE=test 安装，不构成完整契约观测接口。
- 修复 root dev filter、Playwright ESM cwd/服务就绪/端口；Vitest 使用独立 src include，避免误收集 Playwright；ESLint 配置及领域导入限制；Three runtime/types 对齐 0.160，纳入 pnpm lockfile。

## 本机验证证据

环境：macOS arm64，Node 24.21.0，pnpm 8，Chromium Playwright。全部为开发自测，未勾选独立验收清单。

| 命令 | 结果 / 覆盖 |
|---|---|
| `pnpm test` | 11 个 core 文件，83 用例通过；web-ui 暂无 Vitest 单测，显式 passWithNoTests |
| `pnpm lint` | core/web-ui 通过 |
| `pnpm build` | core 类型产物与 web-ui 生产构建通过；主 JS 822.17 kB/gzip 229.27 kB，仍有大包警告 |
| `pnpm --filter @labelfaster/web-ui test:e2e` | 4 个 Chromium 用例通过：7 画布启动无 runtime/console errors；真实属性输入→保存→撤销→刷新→重做；第二标签页只读；真实 BEV 两阶段绘制单次提交、Escape 取消和撤销 |
| `pnpm verify:preflight` | 5 个 schema 样例、S-mini 66 文件、R-mini 403 文件校验通过 |
| `node scripts/audit/architecture-probes.mjs` | 10 项观察：batch 有日志；拆分前后 4/5/6 一致；undo end=10；故障事务无残留；cancel AbortError 且账本归零；clear 不回填；坏导入保留 old；移动只新增第5帧；undo 有记录；切序列无旧轨迹 |

浏览器测试曾暴露刷新后未释放 lease，现已通过 Web Locks 与 page lifecycle 修复。没有通过等待租约到期或绕过生产 Session API 来掩盖该问题。IndexedDB 独立测试覆盖 envelope 升级、日志恢复、重复/错 revision 拒绝和 fencing；持久化测试覆盖失败重试和订阅异常不破坏提交。

## 后续未完成项

1. v2 完整垂直迁移：坐标/时间/ID/精度、AttributeStore、ReviewLedger，接入真实夹具和标定精度检查。
2. ResourceCoordinator 三阶段预算、Worker 解码、GPU 上传准入/峰值、低预算切帧降级，30 分钟和 L-scale 实测。
3. 只读 Repository 和子入口、ChangeSet 维度与 dirty slot、React selectors、Session 职责拆分。
4. 日志 checkpoint、分页/限额、dataset version hash；正式自有格式/nuScenes profile 的独立导出验证及复核门禁。
5. Python 共用 PCD reader、流式分桶世界点云工具；未运行大资产重生成。
6. J01/F01–F06 完整独立验收、自动 CI 与证据归档、真实相机差异/缺失模态浏览器测试、bundle 分拆。

`verify:journey`、`verify:faults`、`verify:exports`、`verify:performance` 保持 BLOCKED 占位；上述 4 个浏览器用例不替代它们。实现降低了可复现风险，性能收益尚无目标数据/硬件实测数字。

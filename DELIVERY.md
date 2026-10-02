# DELIVERY — 当前实施交付

更新：2026-10-02。本轮在 `83aea5ed05d5adea4fa08e7b977080fbe0517e1a` 上实施架构审计建议，本次提交只包含架构修复与对应证据，后续 UI 优化另行提交。完整证据与边界见 [架构优化实施记录](docs/architecture-implementation-2026-10-02.md)，历史问题见 [实现审计](docs/architecture-audit-2026-10-02.md)。

## 本轮完成范围

- v1 领域事务原子性、统一 batch 日志、patch/inverse、拆分边界、undo 恢复区间、导入/序列替换验证和 ID 碰撞防护。
- requested/presented 帧协调、逐相机图像、加载编辑门禁、晚到响应隔离、显式零平面/未知高度处理。
- scheduler 预约/实际字节、pin、取消与统一释放；FrameBuffer、height、BEV 和 world cloud 接入。
- IndexedDB durable commit→publish、保存失败重试、undo/redo 恢复、Web Locks + fenced lease、分条追加日志及旧 envelope 自动升级。
- 全局 QA 的持久化、编辑失效和精确 undo 恢复；相机/三视图/覆盖率缓存与生命周期修复。
- dev/lint/test/E2E 入口修复、领域导入限制、Three 类型版本对齐、受控 lockfile、测试模式只读 probe。

## 自测结果

| 验证 | 结果 |
|---|---|
| `pnpm test` | core 11 文件/83 用例全部通过；web-ui 无 Vitest 单测，浏览器用例单独运行 |
| `pnpm lint` | 通过 |
| `pnpm build` | 通过；主 JS 仍有大包警告 |
| `pnpm --filter @labelfaster/web-ui test:e2e` | Chromium 4/4 通过：启动、编辑保存/撤销/刷新/重做、多标签写互斥、BEV 绘制/取消/撤销 |
| `pnpm verify:preflight` | 通过；schema 样例、S-mini 66 文件/R-mini 403 文件校验通过 |
| `node scripts/audit/architecture-probes.mjs` | 10 项定向观察符合本轮修复预期；运行前先构建 core |

以上为实施自测，未做独立验收，未勾选 M1 清单。E2E 使用 v1 demo，不能证明 v2 真实数据旅程、标定精度或目标规模性能。

## M1 状态与未覆盖能力

H0 数据和规范基线继续保留。H1–H4 **尚未完整完成**；本轮部分实现覆盖旧差距项，不等于 M1 通过。规范决定见 [DECISIONS](DECISIONS.md)，逐验收差距见 [gap-analysis](docs/gap-analysis.md)。

- v2 Z-up/timeUs/UUID/半开区间/Float64、AttributeStore、ReviewLedger 尚未迁移；运行入口明确拒绝 v2，不能直接读 v2 S-mini/R-mini。
- 当前资源账本只管理现有资源/预约，不是完整 encoded/decoded/transient/GPU 三阶段 Coordinator；无 Worker 解码/GPU 上传门禁及长时/L-scale 实测。
- 局部 QA 不是完整区间复核系统，正式导出门禁、nuScenes profile 和独立读取器尚缺；UI 明示 nuScenes 为草稿。
- 日志 checkpoint、恢复分页/容量上限、dataset/标定版本 hash、只读 Repository、dirty slot 和正式 EditScope 尚缺。
- J01、F01–F06、完整契约 probe、CI、Python reader/流式工具及包体分拆尚待实施。
- R-mini 相机外参链 R_rect_02 和官方参考框的渲染对齐仍需独立核验。

## 重跑入口与数据位置

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm lint
pnpm build
pnpm --filter @labelfaster/web-ui exec playwright install chromium
pnpm --filter @labelfaster/web-ui test:e2e
pnpm verify:preflight
node scripts/audit/architecture-probes.mjs
```

`verify:domain` 等同 core tests。`verify:journey`、`verify:faults`、`verify:exports`、`verify:performance` 仍为 BLOCKED 占位（exit 2），不能用上述 E2E 成功替代其结果。

H0 夹具保留于 `fixtures/s-mini/`（31 帧、独立期望与 66 文件校验和）和 `fixtures/r-mini/`（200 帧、官方标注参考 49 轨迹、403 文件校验和）。资产本体按现有 .gitignore 不入库；生成器及校验和可重现。`pnpm fixtures:r-mini` 仍需要 `/tmp/kitti4d/raw_drive.zip`，缺失时保持 BLOCKED。

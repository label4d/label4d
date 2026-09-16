# DELIVERY — M1 实施交付

格式遵循 `docs/implementation-handoff.md` §5。当前为 **H0 阶段交付**（基线与数据），H1–H4 未完成。

## 交付版本 / 工作区基线

- 分支 main；本交付对应提交：文档 `40554e4` → H0 `待填（本次提交）`。
- 审计对象：commit `40554e4` 实际代码。

## 本轮范围

M1 的 H0 包：差距表、语义决定（DECISIONS）、manifest v2 schema + 合法/非法样例 + 校验器、S-mini 夹具（生成器 + 独立答案 + 校验和）、R-mini 组装（真实 KITTI 数据 + 官方标注独立参考）、`verify:preflight` / `verify:domain` 可运行。

## 差距表

见 `docs/gap-analysis.md`（逐验收 ID：已有待验证 / 需修改 / 缺失 / 缺外部输入）。

## 规范决定

见 `DECISIONS.md`（D-01 至 D-10）。关键项：世界系迁移至契约 Z-up（v1 数据不兼容，提供转换路径）；时间轴迁移至 timeUs + 半开区间；业务身份迁移至 UUID；nuScenes 保持 BLOCKED。

## 完成的验收 ID（自测，非独立验收）

- 无 M1 清单 ID 完整通过。H0 相关部分状态：
  - ENV-01：部分（启动/构建/测试命令可运行；隔离 profile 与 verify:journey 未落地）
  - DATA-01：部分（S-mini 生成器 + 独立答案 + 校验和已交付；生产加载管线尚不能读 v2 manifest → 加载路径未验证）
  - DATA-02：部分（R-mini 组装成功且 manifest 校验通过；模态齐全：lidar/cam2/pose/BEV 底图/官方参考标注 49 轨迹；**相机外参链 R_rect_02 语义需在 H1 以渲染对齐核验**）
  - DATA-03：未通过（现实现 Y-up/闭区间，契约 Z-up/半开——D1 迁移未完成）

## 可运行命令

```bash
pnpm install
pnpm fixtures:s-mini        # 生成 S-mini（31 帧 + 独立答案 + 校验和）
pnpm fixtures:r-mini        # 组装 R-mini（需 /tmp/kitti4d/raw_drive.zip，缺失则 BLOCKED）
pnpm fixtures:validate      # manifest v2 schema 校验（S-mini + R-mini）
pnpm verify:preflight       # 环境/依赖/schema/样例/夹具校验和
pnpm verify:domain          # core 领域测试（43 用例）
pnpm dev                    # 打开应用（demo 模式或 /?manifest=/kitti/manifest.json）
```

退出码约定按契约 §5（0/1/2/3）；verify:journey、verify:faults、verify:exports、verify:performance 当前为 BLOCKED 占位（exit 2）。

## 数据位置与校验和

- S-mini：`fixtures/s-mini/`（manifest v2 通过 schema；独立答案 `INDEPENDENT_EXPECTED.json`：J01 关键帧、插值期望、8 个投影控制点；66 文件校验和）
- R-mini：`fixtures/r-mini/`（200 帧 Z-up 世界系点云/图像、ENU pose、BEV 底图、官方标注参考 `reference-answers.json` 49 轨迹；403 文件校验和）
- 生成资产本体不入库（.gitignore），校验和 + 生成器 + 获取说明入库，可重现。

## 已知问题 / FAIL / BLOCKED

- BLOCKED：J01 自动化、F01–F06、独立导出验证器、性能档位（对应 H2–H4）。
- NEEDS_REVIEW：R-mini 参考轨迹框中心 Z 值（部分 ~0.1m）与渲染对齐需在 H1 核验；相机外参 R_rect_02 链路同样待渲染核验。
- 技术债：现实现 Y-up/闭区间/字符串 ID/内存 oplog——全部列入差距表 D1/D2 迁移项，未静默变更。

## 下一轮（H1）未覆盖能力

v2 领域层迁移（Z-up/timeUs/UUID/半开区间/AttributeStore/ReviewLedger）、IndexedDB 持久化、手势事务 ChangeSet、FrameCoordinator、只读观测接口 `window.__LABELFASTER_TEST__.read`。

# Labelfaster 实现架构复查与优化路线

日期：2026-10-02（Asia/Shanghai）。代码基线：`83aea5ed05d5adea4fa08e7b977080fbe0517e1a`，开始时工作区干净。

本轮读取实际 TypeScript 实现、React 视图、离线工具及架构/交付文档，执行构建、核心测试、preflight、lint、E2E 入口和定向复现。没有修改产品行为。本报告是实现审计，不替代独立验收；没有完成真实浏览器手势、长时显存或 L-scale 性能测量。

后续更新：用户授权实施后，首批修复及验证结果见[架构优化实施记录](architecture-implementation-2026-10-02.md)。以下内容保留为实施前审计，不代表修复后的运行状态。

## 1. 结论

保留 monorepo、稀疏关键帧、命令模式、Session 组合根、纯数学投影和实例化渲染。当前主要问题是**正确性边界没有闭合、资源所有权不一致、派生计算重复执行**。优化投入顺序应为：数据正确性 → 帧与资源一致性 → 保存恢复 → 派生计算与渲染 → 交付验收。

文档中的 v2 是目标架构，运行代码主要仍是 v1。继续补功能或扩大缓存会增加不一致风险；没有证据支持现在改成 ECS、引入微服务或全面重写。

## 2. 本轮验证结果

| 入口 | 结果 | 能证明什么 |
|---|---|---|
| `pnpm --filter @labelfaster/core test` | 8 文件、51 用例全部通过 | 现有核心用例通过，未覆盖下面复现的关键不变量 |
| `pnpm build` | core 与 web-ui 成功 | 类型与打包通过；主 JS 786.08 kB，gzip 218.85 kB，存在体积警告 |
| `node scripts/verify-preflight.mjs` | 通过 | 5 个 manifest 样例、S-mini 66 文件及 R-mini 403 文件存在且校验和一致；不证明运行时能加载 v2 |
| `pnpm lint` | 失败 | ESLint 8 找不到配置，检查门禁尚未建立 |
| `pnpm --filter @labelfaster/web-ui test:e2e` | 启动失败 | ESM 配置中使用 `__dirname`，测试尚未进入页面 |
| `node scripts/audit/architecture-probes.mjs` | 输出 10 项观察 | 复现批量日志、插值、撤销、原子性、取消、清理、导入、作用域、日志与序列隔离问题 |

复现脚本依赖当前构建：先执行 `pnpm --filter @labelfaster/core build`。脚本只输出观察，不将已知错误标记为验收通过。测试环境为 macOS arm64、Node 24.21.0；上述 bundle 数字是本轮构建结果，不是加载时延指标。

## 3. 正确性与可靠性发现

优先级：P0 为可能造成错误标注、部分提交或编辑流程中断；P1 为生产闭环所需能力或明显性能/维护风险；P2 为后续工程优化。缺失能力与已复现缺陷分别说明。

### A01 / P0：批量操作修改数据后日志记录抛错（已复现）

位置：`packages/core/src/command/History.ts:20`、`packages/core/src/session/EditorSession.ts:179`、`packages/core/src/command/commands.ts:493`。

`Transaction.payload` 是数组，而 Session 与 `createCommand('batch')` 按 `{ children }` 读取。经 Session 执行两条 AddTrack，得到 `TypeError: payload.children is not iterable`；此时两个对象已经加入、undo 栈已有命令、OpLog 为 0。复制多个对象、混合删除、辅助导入等路径受此接口错配影响。

统一版本化事务记录结构，保留整个 batch 的边界；执行、记录、发布 revision 采用一致提交协议。增加“通过 Session 提交 batch → 重放 → 单步 undo”的集成用例。仅修数组读取不能解决批量原子性和日志可靠性。

### A02 / P0：事务不具备失败原子性（已复现）

位置：`packages/core/src/command/History.ts:28`、`:57`。

第二个子命令抛错时，第一个已写入的对象保留。每个子命令还独立触发 storeChanged，订阅者可能看到中间状态。History 先改 store、后入栈/record；记录失败也不会撤销已写入状态。

短期增加前置校验、逆序回滚及事件批处理；长期用 staged patch/逆 patch 提交，文档 revision 每个逻辑事务只递增一次。领域提交与持久化提交的可见性必须明确，失败路径不能仅依赖 UI 捕获异常。

### A03 / P0：拆分与 undo 没有保持文档语义（已复现）

位置：`packages/core/src/command/commands.ts:84`、`:263`，`packages/core/src/model/TrackStore.ts:220`。

- 轨迹 0/10 帧 x=0/10，在第 5 帧拆分：第 4/5/6 帧原 x=4/5/6，拆分后变成 0/10/10。只分配现有关键帧，没有补边界状态，改变两段解析结果。
- 在原存在区间 `[0,10]` 外加入第 20 帧关键帧再 undo：关键帧撤销，但 endFrame 仍是 20，第 15 帧仍解析出对象。命令只保存关键帧，不保存被自动扩大的区间。

拆分前解析边界并补关键帧，验证切分点合法性；命令捕获完整受影响元数据和逆补丁。新增关键帧、拆分、合并、裁剪都需验证“操作前后未修改范围保持一致”“undo 后语义等价”，不能只检查对象数量。

### A04 / P0：编辑作用域和手势帧未被统一约束（代码确认，移动已复现）

位置：`packages/core/src/session/EditorSession.ts:327`、`:446`、`:474`，`apps/web-ui/src/views/BevView.tsx:261`。

移动/方向键微调及旋转使用 `[0, Number.MAX_SAFE_INTEGER]`，会修改整条轨迹，而文档默认是当前呈现帧关键帧编辑。第 5 帧移动 x+1 后，第 0/10 帧同时变为 1/11，未新增第 5 帧关键帧。

Session 在最终编辑 intent 才 pause；setFrame 不取消手势，工具也未绑定 begin 时的 presentedFrame/revision。BEV 空白左键一律走平移分支，没有按绘图工具分流；可能阻断空白处开始绘图，需要真实手势验证。视图未建立完整 pointercancel/lostpointercapture 路径。

显式引入 `EditScope = currentFrame | interval | wholeTrack`，默认 currentFrame；每次手势建立 frame/revision/scope 上下文，开始时暂停，切帧先取消。preview 归 Session 管理，各视图读同一份预览。输入适配器集中处理 capture/cancel/blur。

### A05 / P0：当前帧号与传感器呈现不一致（代码确认）

位置：`packages/core/src/session/EditorSession.ts:174`、`packages/core/src/render/PointCloudFrameView.ts:44`、`apps/web-ui/src/views/CameraView.tsx:140`。

playhead 先更新 frame，资源异步加载。PointCloudFrameView 明确保留旧点云；相机缺图时也保留旧图，但框与拾取按新 frame 计算。用户可能在旧传感器证据上编辑新帧，不仅是加载时闪烁问题。

增加 FrameCoordinator：requestedFrame 与 presentedFrame 分离，所有编辑/投影/拾取使用同一 FrameContext。资源未满足呈现策略时维持一致旧帧，或进入显式 loading 并禁用拾取。记录传感器 sample/time、标定版本和 epoch，晚到结果不能改变已失效上下文。

### A06 / P0：多相机视图没有按相机加载图像（代码确认）

位置：`packages/core/src/session/EditorSession.ts:257`、`:348`，`apps/web-ui/src/views/CameraView.tsx:128`、`:143`。

Session 只为 `manifest.cameras[0]` 创建一个 imageFrames。所有 CameraView 调用同一个 currentCameraImage，却使用各自 projector。多路展示可能成为“第一路图像 + 其他相机标定”。cameraId 按钮只触发 effect 重建；wantedId 仍由 index 决定，没有使用该选择。

建立按 cameraId 的 CameraFrames Provider，资源 ID 包含 datasetVersion/cameraId/sampleId；接口使用 `image(cameraId, presentedContext)`。测试用内容可区分的两路图像和不同外参验证路由，不能仅检查多 canvas 出现。

### A07 / P0：取消与驱逐没有一致的资源所有权（已复现及代码确认）

位置：`packages/core/src/stream/TileScheduler.ts:150`、`:194`，`packages/core/src/stream/FrameBuffer.ts:86`、`:125`。

- 运行中的 10-byte 请求 cancel 后完成：先 dropEntry 减去尚未计入的 bytes，再 resolve 旧资源；loadedBytes 变为 -10。取消并没有阻止调用方接收失效结果。
- FrameBuffer.clear 不取消 pending 或增 generation；晚到结果会重新填充已 clear 的 cache。已加载条目调用 cancel 而非 release，调度器仍可能持有资源。
- FrameBuffer 全部使用 1MiB 估计值，解码后真实字节只记本地账本，不修正全局账本。全局 eviction 未同步移除 FrameBuffer cache 或 HeightField tiles，没有完整的 lease/pin 协议。

先修非负账本、取消终态和 clear/dispose generation。资源只由一个 owner 决定释放，视图通过 lease 使用；当前呈现和手势资源 pin。随后拆 fetch/decode/upload 阶段，统一 encoded/decoded/transient/GPU 的预约与实际字节。不能用增加总预算掩盖失真记账。

### A08 / P0：序列切换和导入缺少原子替换边界（已复现及代码确认）

位置：`packages/core/src/session/EditorSession.ts:204`、`:710`，`packages/core/src/io/snapshot.ts:133`。

loadManifest 没有清理原 store/history/selection/qa，也没有 load epoch。新序列加载后旧序列对象仍存在。FrameBuffer 资源 ID 仍是 `pcd:frame` / `img:frame`，共享 scheduler 可能命中上一序列缓存；并发 loadManifest 还可能乱序覆盖 ego/projectors。

applySnapshot 逐对象写入且不清空旧文档，不验证 sequenceId/版本/完整领域不变量。导入“一个合法对象 + 一个非法对象”失败后，旧对象和首个新对象同时保留；history 也没有与替换同步重置。

先校验并构造候选文档，再原子 replace；明确另一个 merge API 的冲突语义。序列加载使用独立 epoch、版本化资源身份及旧会话 dispose。pose 加载失败不能静默使用 identity；短 pose 数组中的零矩阵必须拒绝或显式报告。

### A09 / P0：缺高度被写成有效零高度（代码确认）

位置：`packages/core/src/stream/HeightField.ts:85`、`packages/core/src/session/EditorSession.ts:639`。

loading/missing/error/out-of-range 均可能返回 0，被 createBox/createGeometry 直接写入标注。HeightField.sample 遇到已有 pending 请求时拿到立即完成的 Promise，也不保证等待解码完成。顶点编辑使用 `intent.pos.y || sampleHeight(...)`，合法 y=0 会被替换。

返回带状态和来源的 HeightSample；未知高度默认不提交，需要用户明确选零平面/手工值。pending 保存真正 Promise；检查 finite/no-data/边界及所用 LOD，把高度采样依据写入标注来源。

### A10 / P1：保存恢复和复核仍属于目标能力（缺失）

位置：`packages/core/src/command/History.ts:43`、`:125`，`packages/core/src/session/EditorSession.ts:131`，`apps/web-ui/src/panels/Toolbar.tsx:180`。

OpLog/snapshots 只在内存，无 IndexedDB adapter、确认保存 revision、多标签页单写者或崩溃恢复。undo/redo 不记录日志：撤销后的当前数据与重放结果可能不同。qa 是直接赋值的全局 pass/reject，几何变化不会使已复核区间 stale，也无交付门禁。

保留 History 作为用户撤销入口，新增版本化 patch transaction、PersistenceAdapter、SaveState 和恢复流程；undo/redo 也形成 durable transaction。ReviewLedger 分别记录对象和场景覆盖，基于 ChangeSet 失效，正式导出检查缺失资源、未保存 revision、stale review 和阻断问题。

### A11 / P1：v1 实现与 v2 数据/坐标契约脱节（代码确认）

位置：`packages/core/src/io/manifest.ts:71`、`packages/core/src/io/snapshot.ts:67`、`packages/core/src/model/TrackStore.ts:39`，`fixtures/s-mini/manifest.json`。

运行时是 formatVersion=1、Y-up、frame+fps、闭区间、计数 ID、Float32 权威几何；夹具/设计是 v2、Z-up、timeUs、半开区间、UUID、Float64。SessionProvider 将 JSON 直接传入，没有运行时版本解析/迁移。preflight 通过不能证明真实加载链正确。

统一 `parseManifest → validate → migrate → DatasetManifest` 和 document codec；保留明确 v1 adapter，不能猜测坐标。权威世界坐标用 Float64，渲染减局部 origin 后转 Float32。属性存储与几何关键帧解耦，避免新增/删除关键帧牵动人工属性语义。

nuScenes 当前导出 timestamp 使用帧号、Y 轴 quaternion、未经变换的 Y-up translation、类别字符串充 token；不能作为下游兼容证明。待 profile 固定并有独立读取器前，应明确为草稿导出。

## 4. 性能与模块边界优化

以下热点由代码确认；其实际时延和收益仍需浏览器 profiler/目标规模数据测量。

| 热点 | 当前行为与影响 | 优先改法 |
|---|---|---|
| 相机派生计算 | 每路每 rAF 调用 syncFrame；每个框 countBoxSupport 扫约 12k 点，点云投影重新创建 JS 数组和 BufferGeometry。复杂度约为相机数 × activeTracks × 采样点数 × rAF 频率 | support 按 cloud+几何 revision 共享缓存；frame/标定/文档版本驱动投影更新；selection/hover 只更新样式；投影 buffer 复用，重计算迁 Worker |
| 三视图 | ThreeViewStrip 的 `index === 0` 使第一个面板每 rAF setCloud 重建几何；其他面板 cloud/frame 不变时改变选择或深度窗却未触发重建 | 缓存键包含 cloud、focus、depthWindow；三个面板一致按脏标记更新，复用 typed arrays/GPU buffer |
| 播放栏统计 | 每 frameChanged/storeChanged 重算 datasetStats，遍历全部帧并查询全部活跃对象，最坏 O(frames × tracks) | 按结构/存在区间 revision 缓存；覆盖率用区间合并计算，几何位置与选中变化不失效 |
| 框渲染 | TrackInstanceRenderer 有整体 sync key，但任何对象变化会重写全部 active matrix/颜色/静态线；属性编辑也让 intervalIndex 失效 | ChangeSet 按结构/几何/属性/时间范围分维度；稳定 id→slot，按脏对象更新；样式与矩阵分开；固定颜色数组复用 |
| 关键帧编辑 | setKeyframe 替换已有值时仍先 remove 再 insert，重建全部列；TransformTracks 对每个关键帧重复做此操作和 emit | 命令内部批量生成新列，仅发布一次；已有槽值可在不可变提交/逆 patch 契约下局部替换 |
| 点云预取 | ±45 候选直接 ensure，无 Worker 解码和 GPU 准入，统一 scheduler 启动时并不等待整窗排序 | 当前帧保留并发名额；候选/下载/解码驻留分离，方向性小窗口，解码 transferable buffer，GPU 仅呈现组和必要目标组 |
| WorldCloudOverlay | 自己 fetch+按 128 cells 淘汰，绕过统一字节预算/并发/取消；dispose 后晚到 promise 可再创建 GPU 对象 | 作为 ResourceCoordinator Provider 接入，按实际点字节和 lease 管理，终止 epoch 阻止 late upload |
| 多 WebGL 上下文 | 主视图、三个三视图和每路相机各自 renderer，资源无法跨 context 共享 | 先统一 RenderCoordinator/失效调度并计 GPU 字节；按 profiler 结果评估单 renderer+scissor 多视口，避免先做复杂迁移 |

额外正确性/释放细节：TrackInstanceRenderer 的过滤缓存键仅有 hiddenLabels.size，等数量但不同标签集合可能不失效；grow 仅调用 mesh.dispose，没有释放旧 geometry/material；CameraView 注册的匿名 pointer/wheel 监听未完整清理，切 cameraId effect 重建时会累积；EditorSession.dispose 未清 imageFrames/height/blinkTimer。SessionProvider 在 render 中执行加载副作用且缺 dispose，后续 StrictMode/remount 风险需要专门生命周期用例。

点云 support 不应默认作为对象可见性的硬门槛：当前无点云就得到 0，低支撑会使已存在对象从相机显示/拾取中消失。建议显示可见投影，同时把低支撑作为复核提示，具体语义需与产品规则一致。

## 5. 推荐结构：先内部模块化，再决定是否拆包

```text
apps/web-ui                React 装配、面板、DOM 输入、布局
packages/core/domain       Document/Repository、属性、复核、不变量
packages/core/command      patch transaction、逆 patch、History
packages/core/dataset      manifest parser、时间轴、标定、pose、v1 adapter
packages/core/resource     身份、lease、账本、fetch/decode/upload、Providers
packages/core/derived      resolve/projection/support/coverage 缓存
packages/core/frame        requested/presented、FrameContext、epoch
packages/core/persistence  adapter、保存状态、checkpoint/replay、写锁
packages/core/interaction  手势上下文、EditScope、跨视图 preview
packages/core/render       Three.js adapters、GPU resource owner
packages/core/session      用例编排与组合根
```

依赖方向：UI → Session 用例；Session 编排领域/帧/资源/持久化；render 读 presentedContext+derived+preview；domain 不依赖 React、DOM、Three.js。继续保留一个 core 包，先提供 `/domain`、`/session`、`/render` 子入口，建立依赖限制后再根据真实发布需要拆包。

当前所谓“UI 唯一入口”没有落实：PropertiesPanel 直接构造 command、操作 history/store；Toolbar 直接赋 qa；Session store/getTrack/getKeyframes 返回可变内部引用。公开读模型用只读 facade/snapshot，写操作集中到 Session 用例并校验。EditorSession 本身则缩为组合与编排，避免继续吸收 Provider、浏览器图像解码和各种导出职责。

React 订阅从全局 tick 逐步转向 `useSyncExternalStore`+选择器，提供 revision 稳定的 snapshot；所有业务状态有事件，不依赖强制 tick 修补。视图设置通过 SessionState 共享，不再同时混用 CustomEvent、组件 state 与可变公开字段。

## 6. 离线工具与工程门禁

- 四个 Python 脚本重复 PCD 读取，默认布局固定为四个 Float32、只找 `DATA binary\n`，未按 FIELDS/SIZE/TYPE/COUNT 解析。提取共享 reader 并明确拒绝不支持的格式，避免错误读取“合法但布局不同”的 PCD。
- build_world_cloud 一次保留所有帧并 concatenate、sort，工作集随全序列点数增长。改为按网格分桶的流式落盘/外部排序，overview 用固定容量抽样；生成产物附坐标/时间约定、输入 hash、生成器版本。
- Node/Python 的 BEV、高度、世界点云生成及直接修改 manifest 应共享明确格式契约，产物先写临时目录再发布；本轮没有执行这些大体积重生成。
- 修复 Playwright ESM cwd，再更新旧冒烟中的 canvas=2 断言；当前 cloud 模式主视图+三视图已超过 2，测试期待不符合 UI 结构。补真实操作 J01 和取消/错帧/恢复路径。
- 补 ESLint 配置、领域→render 反向依赖禁令、CI 核心测试/build/旅程门禁。root dev 的 `--filter apps/web-ui` 实测返回 `No projects matched the filters`；改用 `@labelfaster/web-ui` 或正确目录选择器并验证启动入口。
- web-ui test 使用 watch 模式；统一 CI 为 run 并避开 Playwright 文件。不把仍为 BLOCKED 的 verify:journey/faults/exports/performance 当作已完成能力。
- Three 运行版本 0.160、types 0.180，应对齐避免类型与运行 API 脱节；pnpm-lock.yaml 被 .gitignore 忽略且当前未纳入文件列表，应纳入受控依赖，固定环境后再升级。

## 7. 实施顺序与退出条件

| 阶段 | 交付内容 | 退出条件 |
|---|---|---|
| R1 正确性修复 | A01–A04、A08–A09 的最小修复，版本入口拒绝未支持输入，明确作用域 | batch 不抛错；失败不留部分数据；split 不改变原解析；undo 恢复区间；导入失败旧文档完全不变 |
| R2 呈现与资源 | FrameCoordinator、逐相机图像、generation、正确账本、统一释放；先接现有 scheduler，再逐步三阶段 | 乱序/seek/切序列/cancel/dispose 不错帧；当前资源不被误驱逐；预算非负且覆盖真实驻留 |
| R3 可恢复闭环 | 版本化 patch、IndexedDB、保存状态、写锁、日志恢复；v2 adapter 和 ReviewLedger 按完整迁移切片接入 | 保存确认 revision 可恢复；undo 后重开不复活；复核正确失效；正式导出受门禁约束 |
| R4 性能与边界 | 先修每 rAF 重算、全序列统计、重复 BufferGeometry；再 dirty slot、Worker、预算峰值和子入口 | 目标数据实测 p95 切帧/拖拽、buffer/GPU 账本及长时稳定性，不仅看画面 FPS |
| R5 验收自动化 | J01/F01–F06、独立导出读取器、源版本/fixture hash/trace | CI 可独立重跑，失败与 BLOCKED 保留证据；实现测试不冒充独立验收 |

优先做一个完整的真实数据垂直切片，把以上阶段持续接到同一生产管线；不等所有领域或所有资源能力完成才验证 UI。坐标/时间/格式迁移应作为明确版本提交，避免夹具、渲染和快照各自“半迁移”。

## 8. 本轮边界

新增本报告和只读复现脚本；未修复上述缺陷、未迁移格式、未改已批准业务语义、未生成真实数据资产。性能复杂度分析来自实现，尚无目标硬件上的性能达标结论。最小故障复现使用构建后的 core API，不能替代真实 pointer/keyboard 驱动的交互验收。

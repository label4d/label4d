# 实施交付接口契约

状态：待实现的契约，不声明现有 API、文件格式或命令已存在。领域规则遵循 `domain-and-streaming-design.md`，本文件固定其他 AI 不能自行猜测的接缝。

## 1. 数据夹具包

每份夹具具有唯一 `fixtureId`、版本、manifest 与逐资产 SHA-256 清单。提供来源、可用范围、大小、模态完整度、预期用例、标定来源和参考答案来源。运行前验证校验和；变动后视为新夹具版本。

夹具分 S-mini（有独立答案）、R-mini（真实连续采样）、L-scale（规模）。资产可放仓库外，但报告必须给可解析位置和获取/挂载说明，不能只给实施者机器上的不可重现路径。所有验收写入独立测试文档/存储命名空间，不能修改原始资产或真实生产标注。

S-mini 和 R-mini 走同一生产 manifest 校验、下载、解码、呈现管线。S-mini 不得依靠浏览器内造几个 Mesh 冒充 PCD/图像加载。测试替身限于故障注入、独立算术检查和资源调度单测。

## 2. Manifest 与坐标契约

实施者提供版本化 JSON Schema、一个最小合法示例和一组非法输入样例；不得只写 TypeScript 类型而不验证外部数据。

| 字段组 | 必需语义 |
|---|---|
| 身份 | `formatVersion, datasetId, datasetVersion, contentHash`；contentHash 对规范化内容计算并排除自身字段 |
| 时间 | `referenceFrames[{frameId,timeUs}]`；timeUs 为相对序列起点的安全整数微秒、严格递增；全局 epoch 单独以字符串记录 |
| 传感器样本 | 每个 sample 的稳定 ID、sensorId、timeUs、resourceId；显式 sample 关联优先，无关联时可按声明的容差取最近，等距取较早样本；重复复用样本需声明允许 |
| Pose | 指定时间的 `T_world_from_ego`；平移线性、旋转 quaternion slerp；不跨越 manifest 声明的最大 pose 间隙，不外推；源数据已补齐时说明 |
| 标定 | 标定版本、传感器类型、变换、相机模型公式标识/系数/图像尺寸/畸变状态，不能只写 fisheye |
| 栅格 | BEV 像素到世界 XY 的变换、图像尺寸、瓦片与 LOD 规则；高度编码、比例/偏移、垂直基准、no-data、采样精度 |
| 资源 | URI、校验和、编码、encoded 大小或有界 header 获取方式、解码尺寸/点数/字段、LOD、最大支持规模 |

本工具内部世界/自车系采用右手 Z 向上；自车 X 向前、Y 向左；世界 XY 朝向由数据原点定义，不强制等于东/北。相机光学系 X 向右、Y 向下、Z 向前。其他源约定在导入适配器显式转换。

变换名称为 `T_to_from`，作用于列向量，矩阵序列化列主序；内参另按明确字段保存，避免行列顺序猜测。空间单位米，角度弧度；quaternion 使用 `[x,y,z,w]`，导入验证有限且归一化。

框位置为几何中心，size 为局部 X/Y/Z 对应的 length/width/height；yaw 绕世界 +Z 按右手正方向。高度图采样是地面高度，地面创建框的中心 Z 为 groundZ + height/2；工具不得把底面坐标写成框中心。

像素坐标原点为左上像素中心 `(0,0)`，x 向右、y 向下；贴图适配负责像素中心与屏幕边界的半像素转换。原始与去畸变图像必须分开声明，不得重复加畸变。

标注存世界系时，相机时间 t 的链路为 `world → ego(t) → camera`；外参保存 `T_ego_from_sensor` 时使用逆矩阵进入传感器系。相机渲染中的动态对象在相机样本时间解析，关键帧仍锚定参考时间轴；sample 超出目标存在范围时不显示对象。独立投影答案必须使用同一时间语义，不能用参考帧姿态套所有相机。

点云需声明是原始扫描还是已去运动畸变，并声明扫描参考时刻。M1 只接受已对齐单帧参考时刻的点云；原始未去畸变数据若缺逐点时间/补偿支持，清楚报告不支持，不伪装成同步输入。

## 3. 快照、日志与导出

首版新文档格式标记 `labelfaster.document.v2`；命名是设计决定，实施前需核实旧版本并提供显式迁移映射，不覆盖未知旧格式。必需内容：documentId、formatVersion、dataset/标定/pose/schema 引用、revision、tracks、staticGeometries、attributes、reviewLedger。

快照以稳定 UUID 表达身份，内部时间半开区间，坐标保留 Float64 信息；缓存、预览、GPU ID、slot/generation 不进入交换语义。JSON 支持数据必须有限；未知版本拒绝并保留原文件。旧属性语义不明确时不得猜测迁移。

本地 M1 选用 IndexedDB：每笔事务原子写入操作 ID、前后 revision、可重放补丁/逆补丁与 head；保存成功以事务 complete 为准。重放有 sequence/operationId 去重和连续性检查，不能遇到损坏记录后跳过继续显示“恢复成功”。IndexedDB durability 能力与浏览器策略在报告中声明，不把事务完成等同于断电保证。

快照保存 revision 和日志边界；先完成快照写入并原子更新引用，才允许清理被覆盖日志。压缩不破坏承诺的 undo 范围，历史分页与容量耗尽必须可解释。同一文档单写者：优先使用 Web Locks；不支持时提供有 fencing token 的持久化租约和事务内所有权检查，不能只用 BroadcastChannel 广播代替互斥。

导出区分：草稿快照始终可备份已提交文档；正式交付检查审核与问题门禁。两者都不含未提交预览；正式导出记录交付 profile、内容摘要及依据 revision。自有 JSON 往返必须保持业务 ID 与语义，运行环境中的文档容器身份可以明确重新分配，但不得悄悄改对象身份。

nuScenes 暂不替实施者猜测检测/跟踪/数据集格式。M1 交付 profile 固定为自有 JSON；其他 profile 的未验证项必须列出，不能写成已覆盖全部导出需求。

## 4. UI 与只读观测

标签单击打开属性编辑器；输入框聚焦期间 Delete/Ctrl+Z/输入法操作按输入控件语义处理。精确框编辑必须能通过用户可见界面修改位置、尺寸、yaw 和当前关键帧，不能只提供测试接口。

选中对象离开存在区间后可在对象列表保留身份选择，但视口不渲染/拾取、不允许编辑 absent 状态；UI 显示该对象不在当前帧。帧加载状态显示请求帧和当前可用帧，不能只改标题保留可编辑旧内容。

测试构建提供 `window.__LABELFASTER_TEST__.read(query)` 只读 Promise 接口；query 仅允许按对象、帧、传感器选择有界数据，禁止每次读取全序列 resolved 状态。返回结构化副本并包含 `probeVersion, capturedAt, documentRevision, renderRevision`。

返回内容分组：

- frame：requested/presented frame、referenceTime、sampleId/time、标定/pose 版本、epoch、各视图 ready/error；
- document：选定对象的关键帧、属性和规范化摘要；
- interaction：selection IDs、工具/手势状态、历史逻辑步数；
- persistence：head revision、saved revision、保存状态和错误；
- review：指定范围的检查维度、覆盖、stale 和问题；
- resources：各账本 resident/reserved/limit、队列、pin/lease 和拒绝原因。

如一次读取跨异步步骤发生 revision 变化，返回 nonAtomic 标记并重试，不能拼成看似一致的快照。观测接口不返回可变对象引用；生产构建默认不暴露测试入口。

网络/存储故障注入入口与观测入口分开，仅测试构建启用；不能修改业务文档使断言通过。验收自动化与独立读取器禁止依赖产品 resolve/project 作为标准答案。

## 5. 可重现命令接口

以下是实施 AI 必须落地的 workspace 脚本名称，不是当前已可运行的命令。每条命令的帮助、输入环境和产物路径都写进交付报告。

| 约定命令 | 职责 |
|---|---|
| `pnpm verify:preflight` | 校验依赖、夹具校验和、浏览器、隔离存储和环境信息 |
| `pnpm verify:domain` | 领域、迁移、日志与资源账本的必要测试 |
| `pnpm verify:journey -- --fixture S-mini` | 启动测试服务并执行完整 J01，支持 R-mini；允许实际启动由上层 runner 管理但须自动化 |
| `pnpm verify:faults` | F01–F06，隔离 profile 与故障设施 |
| `pnpm verify:exports -- --run <run-id>` | 独立校验指定运行的下载文件 |
| `pnpm verify:performance -- --fixture L-scale` | 指定硬件数据下的延迟、资源与长时观测 |

退出码：0 表示所有指定必需项目 PASS；1 表示至少一个产品/测试断言 FAIL；2 表示无 FAIL 但存在 BLOCKED/NEEDS_REVIEW/FLAKY 等非通过状态；3 表示 runner 本身异常。报告同时保留各分项状态，不能用退出码吞掉原因。性能测量应与截图密集的功能运行分开。

computer use 是具备该工具的验收 AI 执行任务，不假装成已有 pnpm 命令。其动作、截图和结论同样归档。未安装工具或环境无法显示页面时记录相应分项未完成。

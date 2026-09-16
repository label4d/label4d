# Labelfaster 架构设计（4D 商业级）

对应 `requirements.md`。设计原则：**数据层框架无关（零 three 依赖）、渲染同步层显式分层、一切修改经命令、一切大资源经调度器**。

领域与资源调度的实施契约见 [领域模型与分阶段资源调度设计](domain-and-streaming-design.md)。这是待实现与验收的设计基线，不代表代码已经符合。

数据格式、坐标约定、本地持久化与测试接缝见 [交付接口契约](delivery-contracts.md)；实施交接和验收入口见 [文档索引](README.md)。

## 1. 规模模型（设计的出发点）

| 维度 | 数值 | 推论 |
|---|---|---|
| 序列 | 5 min @ 10Hz = 3000 帧 | 帧号用 Int32；时间轴必须虚拟化/Canvas 化 |
| 动态 track | 数千条（峰值并发 500+） | 稳定业务 ID；当前帧使用实例化批量渲染 |
| resolved frame-state | 数千 track × 3000 帧 ≈ 百万级 | 稀疏关键帧为真值；按需解析，SoA 用于派生计算与渲染 |
| 逐帧点云 | 10 万 ~ 100 万点/帧 × 3000 帧 | 预取候选与驻留分离；下载、解码、GPU 上传分别准入 |
| BEV 底图 | 吉像素级 PNG | 四叉树瓦片金字塔，GPU 纹理预算 |
| 相机 | 多相机 × 3000 帧 | 图像帧缓冲（仅当前 ± 少量帧） |
| 编辑操作 | 单次 undo/redo < 50ms | 命令必须 O(变更量)，禁止 O(全序列) 快照 |

存储量按实际关键帧、几何顶点、属性区间和历史计算，不能将潜在 resolved 状态数等同于常驻对象数。列式存储是内部优化，不决定领域模型；具体布局通过真实负载验证。

## 2. 领域模型与存储边界

AnnotationDocument 持有 Track、StaticGeometry、AttributeStore、ReviewLedger；DatasetManifest 作为版本化只读输入。选择、hover、工具预览属于 SessionState，解析状态、投影和资源表示属于可重建缓存。

- **身份与精度**：UUID 为持久化业务 ID，内部可用 slot + generation；权威坐标 Float64，局部原点变换后再转渲染 Float32。
- **轨迹与几何**：Track 保存稀疏框关键帧；静态折线/多边形为平级对象。内部时间统一半开区间，UI 显示首末帧，版本化格式处理旧闭区间迁移。
- **属性**：独立保存对象基础值及不重叠时间覆盖；schema 声明对象/传感器作用域。几何关键帧删除不删除人工属性。
- **复核**：对象检查和场景完整性检查分别记录，绑定内容与标定等依赖。ChangeSet 使受影响区间过期，保留原始审核记录。
- **查询与存储**：Repository 隐藏列布局；按需解析关键帧二分 O(log k)，按需生成 SoA。activeAt 可先扫描数千对象，实测后选索引，不预先断言 <1ms。
- 选择/显隐拥有独立版本，不污染标注文档 revision；渲染接收对象、时间区间和维度的 dirty hints。

## 3. 时间与插值

- 全局坐标系存储（跨帧一致），渲染时按逐帧 ego pose 变换到自车系（可切换显示）。
- `resolve(trackId, frame)`：关键帧二分 → 命中直接返回；区间内按时间戳线性插值 pos/size，yaw 走最短弧，恰为 π 时统一取正方向；首末关键帧外、存在区间内使用边界 hold；区间外 absent。
- hold 模式（阶梯）：取前一关键帧，不插值。
- 编辑默认设置当前呈现帧关键帧；命令计算前后邻接区间并集，用于预览提示、缓存与复核失效。拆分/裁剪补边界状态以保持原解析结果，具体规则见详细设计。

## 4. 命令 / 事务 / OpLog

- 命令携带稳定对象 ID、基准 revision 和作用范围，产生补丁/逆补丁及 ChangeSet；全部经 History。典型命令：AddTrack、DeleteTracks、SetKeyframe、RemoveKeyframe、TransformTracks、SetTrackMeta、SetAttribute、SplitTrack、MergeTracks、Add/Update/DeleteGeometry、ImportCandidates、RecordReview。
- **Transaction**：多条命令合并为单步 undo（模型辅助批量导入必须单步可撤）。
- **OpLog**：持久化可序列化事务与 schema 版本，不保存方法闭包。校验暂存 → 原子持久化 → 发布文档 revision；undo/redo 也落日志。失败不显示已保存。快照结合日志体积和恢复耗时触发；JSON 交换可用 base64，二进制持久化不强制 base64。

## 5. 流式加载：统一账本，三阶段准入

ResourceCoordinator 维护统一资源身份与 lease、字节账本以及 fetch/decode/upload 三队列。每个资源可分别持有 encoded/decoded/GPU 表示，独立释放；开始工作前预约输出和临时峰值，失败/取消确认完成后释放预约。

初始 standard 配置：encoded 192MiB、decoded 640MiB、transient 192MiB，CPU 受管理资源合计 1024MiB；GPU 估计总预算 512MiB，其中 96MiB 留作驱动余量。预算覆盖所有资源类型；不是浏览器总 RSS 保证。fetch 并发 6（推测最多 4），decode Worker 2（推测最多 1），upload 每 rAF 以 2ms/8MiB 为启动预算目标；不可分割的大纹理单独记录并验收。

各 Provider 共享以上规则：

1. **PointCloudFrames**：±45 帧为候选范围，按速度与延迟形成方向性预取。CPU 初始目标当前 + 前向 3 + 后向 1 帧，预算不足缩小；GPU 仅当前组与一个目标组；binary PCD 解码在 Worker 执行。
2. **BevPyramid**：DZI 式四叉树瓦片；视口 → 所需瓦片集合（按 zoom = 正交相机高度映射）；最低分辨率全图纹理常驻兜底。
3. **HeightField**：高度图按标注精度采样，区分 ready/loading/missing/error；无数据不静默写 0，用户明确选零平面或手工高度并记录来源。
4. **PotreeOverlay**（静态超大点云叠加，可选）：解析 Potree2 `metadata.json`/`hierarchy.bin`，按视锥误差排序节点，点解码委托注入的 LAZ decoder（`potree-core` 或 laz-perf 适配）。
5. **CameraFrames**：记录每图时间戳及原始/显示尺寸，按可见视口准备 GPU 图像，encoded/decoded 可独立缓存。

当前呈现/手势资源 pin；淘汰先远期预取，再不可见细节，最后非必要邻帧。同优先级且未 pin 才用 LRU。共存不足时显式 loading 并禁用旧帧拾取后释放旧帧；单帧也超限则使用声明的显示 LOD 或报告配置/数据错误。禁止无限驱逐重试。

FrameCoordinator 将 requestedFrame 与 presentedFrame 分离，以时间、传感器样本、标定/pose、标注 revision 和 epoch 形成一致上下文。旧响应可被缓存，但不能覆盖当前呈现。复核播放不足则缓冲，快速浏览跳帧必须显式标示。

## 6. 视图体系（全部 Three.js）

| 视图 | 相机 | 内容 |
|---|---|---|
| 3D 主视图 | Perspective + OrbitControls | 当前帧点云、3D 框、几何、网格 |
| BEV 视图 | Orthographic（俯视） | 瓦片底图、高度着色（可选）、3D 框俯视投影、折线/多边形、绘制工具主场 |
| 相机视图 | Orthographic（图像像素系） | 相机图像平面、4D 对象投影（8 角点线框 + 底面填充 + 朝向指示 + 属性标签平面）、点云深度投影点、**可点选**；与所有视图一致，整个场景经单一 WebGLRenderer 渲染 |
| 三视图 ×3 | Orthographic（沿 X/Y/Z 轴） | 当前帧点云正交投影（几何共享，独立 Scene）、对象 2D 轮廓 + 朝向、深度裁剪、可点选 |

- **投影管线**（纯数学，核心库内，无 three）：`world → ego(sampleTime) → camera → 像素`，对象状态与 pose 在对应相机采样时刻解析，输出投影多边形/角点 + 可见性；参考帧用于关键帧编辑，传感器样本按容差关联。
- **相机模型注册表**：`ProjectionModel` 接口 = `project(camPoint) → pixel`；内置 `pinhole`（Brown-Conrady 径向+切向畸变）与 `fisheye_equidistant` / `fisheye_equisolid`（theta 多项式畸变，OpenCV fisheye 约定）；manifest 每相机声明 model 类型，注册表可扩展（OCam/ATAN 预留）。
- **视图内属性系统**：属性 schema 挂在 LabelDef 上（key/type/enum/default）；3D/BEV 用 canvas-texture Sprite 徽标（track id + 类别 + 属性值），相机视图用像素系文字平面；点击徽标 → React 定位弹层编辑（schema 驱动控件）→ SetAttribute 命令。密度控制：选中/悬停必显，其余按屏幕投影尺寸阈值，全局开关。
- **自车轨迹**：EgoTrack 提供逐帧 pose；轨迹渲染为 Line + 帧点标记，拾取命中点 → `session.setFrame`；播放跟随 = 相机 target 锁定 ego(frame)。
- **选中传播**：Selection 是全局唯一事实（版本号），任一视图点选 → store 更新 → 全部视图 + 面板同步高亮；hover 是轻量旁路状态（不进 undo）。
- **渲染同步是脏标记增量**：store 变更发 `storeChanged(version, dirtySet)`；`TrackInstanceRenderer` 维护 `entityId → instance slot`，只写变化的 instance matrix；**任何视图不允许直接改数据**，也不做全量重建。

## 7. 交互：显式工具状态机

状态：`idle / marquee / move / rotate / boxDraw(first|second) / polylineDraw / polygonDraw / vertexEdit`。转移表显式声明，非法转移拒绝并返回原因；指针手势由视图适配成归一化事件（屏幕 + 世界坐标）喂给状态机；状态机产出**意图**（intent），由 Session 落成命令。播放中开始编辑 → 自动暂停。

手势锁定呈现上下文，执行 begin → preview → commit/cancel；pointermove 只改 Session 预览，一次提交一条历史。切帧先取消预览；Esc/pointercancel 不修改文档。

## 8. Session（组合根）

`EditorSession` 装配 document/history/oplog/review/playhead/frameCoordinator/selection/tools/resourceCoordinator，是 UI 唯一入口：
`load(manifest)`、`setFrame(f)`、`play()`、`undo/redo()`、`applyToolIntent()`、`pick(viewport, screenPos)`、`exportSnapshot()`。UI = 视图装配 + 面板，无业务逻辑。

## 9. 包结构与文件地图

```
packages/core/src/
  events/        类型化 EventEmitter（实例化，非单例）
  entity/        内部槽位句柄与稳定 ID 映射（可选优化）
  model/         AnnotationDocument、Track/Geometry Repository、AttributeStore、LabelDefs
  review/        ReviewLedger、依赖与覆盖计算、交付门禁
  derived/       按需解析、SoA、投影缓存与失效
  command/       History、Transaction、OpLog、具体命令
  geometry/      纯数学：vec3/mat4/yaw、OBB 角点、ray-OBB、point-in-polygon
  projection/    相机投影（内外参 + 畸变）、ego/global 变换
  stream/        ResourceCoordinator、预算/lease、fetch/decode/upload 队列、五类 Provider
  playback/      Playhead（注入 rAF）、FrameCoordinator
  interaction/   ToolMachine、手势协议、意图定义
  assist/        模型辅助适配器接口 + 候选批量导入
  io/            Manifest、Snapshot 序列化（base64 typed array）
  render/        （three 依赖唯一区域）TrackInstanceRenderer、PointCloudFrameView、
                 BevTileRenderer、CameraImageView、ThreeViewPanel、视图基类
  session/       EditorSession
apps/web-ui/src/
  session/       SessionProvider + hooks（useSessionFrame 等）
  views/         ThreeDView / BevView / CameraView / ThreeViewStrip
  panels/        Timeline（canvas）/ ObjectList / Properties / Toolbar / PlaybackBar
```

## 10. 验收路径

- vitest：store/插值/命令/调度/PCD 解析/投影数学。
- `tsc -b` 全仓 + `pnpm -r build` 通过。
- UI 冒烟：加载样例 manifest → 播放 → BEV 画框 → 相机投影点选 → undo 链路。
- 正式验收按详细设计 D1–D2、S1–S3：领域不变量、真实鼠标手势、复核区间失效、提交前后崩溃、分阶段峰值预约、晚到响应、共存不足、长时资源释放。冒烟不替代这些证据。

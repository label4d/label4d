# Labelfaster 架构设计（4D 商业级）

对应 `requirements.md`。设计原则：**数据层框架无关（零 three 依赖）、渲染同步层显式分层、一切修改经命令、一切大资源经调度器**。

## 1. 规模模型（设计的出发点）

| 维度 | 数值 | 推论 |
|---|---|---|
| 序列 | 5 min @ 10Hz = 3000 帧 | 帧号用 Int32；时间轴必须虚拟化/Canvas 化 |
| 动态 track | 数千条（峰值并发 500+） | 逐帧 resolved 实例 ≤ 5k，InstancedMesh 一塌糊涂地合适 |
| resolved frame-state | 数千 track × 3000 帧 ≈ 百万级 | **禁止**为每帧每对象建 JS 对象；按需解析 + SoA 列式存储 |
| 逐帧点云 | 10 万 ~ 100 万点/帧 × 3000 帧 | 环形窗口预取 + LRU，内存预算约束 |
| BEV 底图 | 吉像素级 PNG | 四叉树瓦片金字塔，GPU 纹理预算 |
| 相机 | 多相机 × 3000 帧 | 图像帧缓冲（仅当前 ± 少量帧） |
| 编辑操作 | 单次 undo/redo < 50ms | 命令必须 O(变更量)，禁止 O(全序列) 快照 |

结论：任何"每对象一个 class 实例 + 每帧一个对象"的朴素建模在 10^5~10^6 状态下会被 GC 和指针追逐杀死。这就是存储层选择列式 ECS 的原因。

## 2. 存储层：列式 ECS（不是游戏循环 ECS）

采用 **ECS 的存储模型**（entity 句柄 + 组件列 + 代数计数防悬挂），**不采用** tick 驱动的 system 调度——标注是事件驱动的编辑器，不是每帧跑满的游戏。这个取舍是刻意的：

- **Entity**：`u32` id + `u32` generation（防止悬挂引用，删除后句柄自动失效）。
- **组件列**：`Label`、`TrackInterval`、`Keyframes`（SoA：`frames:Int32Array`、`pos:Float32Array`、`yaw:Float32Array`、`size:Float32Array`、`attrs:Map`）、`Geometry`（折线/多边形顶点 `Float32Array` + 类型 + 时间区间）。批量操作（按类别平移、批量删除、统计）走列数据，缓存友好。
- **Query**：`activeAt(frame)` 由**区间索引**支撑（按 start 排序的 interval 数组 + 二分 + 脏标记重建，变更 O(n) 重建但 n=数千，<1ms）；`resolveState(trackId, frame)` 关键帧二分 + 插值，O(log k)。
- 选择集、显隐过滤都是"查询结果 + 版本号"，渲染层按版本号决定是否重建 instance buffer。

## 3. 时间与插值

- 全局坐标系存储（跨帧一致），渲染时按逐帧 ego pose 变换到自车系（可切换显示）。
- `resolve(trackId, frame)`：关键帧二分 → 命中直接返回；区间内线性插值 pos/size，yaw 走最短弧；插值策略是接口（预留 cubic/样条）。
- hold 模式（阶梯）：取前一关键帧，不插值。

## 4. 命令 / 事务 / OpLog

- `Command { do(): inverse; undo() }`，全部经 `History`；典型命令：AddTrack、DeleteTracks、SetKeyframe、RemoveKeyframe、TransformTracks（区间批量变换）、SetTrackMeta、SplitTrack、MergeTracks、Add/Update/DeleteGeometry、ImportCandidates（事务）。
- **Transaction**：多条命令合并为单步 undo（模型辅助批量导入必须单步可撤）。
- **OpLog**：命令 JSON 按序追加 + 每 200 操作快照序列化。崩溃恢复 = 快照 + 重放。序列化带 `formatVersion`，typed array 用 base64 打包（商业数据集体积要求）。

## 5. 流式加载：一个调度器，三类资源

`TileScheduler`（统一）：优先级队列（视锥/屏幕空间误差/距 playhead 距离）、并发上限（默认 6）、按字节的内存预算、LRU 驱逐、失焦请求中止。

三类 `Provider` 挂在同一调度器上：

1. **PointCloudFrames**：`FrameBuffer` 环形窗口（当前 ±45 帧默认），预取方向跟随播放方向；解析 binary PCD（含 intensity）；当前帧 Points 可见，窗口内其余驻留缓存。
2. **BevPyramid**：DZI 式四叉树瓦片；视口 → 所需瓦片集合（按 zoom = 正交相机高度映射）；最低分辨率全图纹理常驻兜底。
3. **HeightField**：高度图分块 PNG → Float32 列，双线性采样接口；无数据 → z=0。
4. **PotreeOverlay**（静态超大点云叠加，可选）：解析 Potree2 `metadata.json`/`hierarchy.bin`，按视锥误差排序节点，点解码委托注入的 LAZ decoder（`potree-core` 或 laz-perf 适配）。

## 6. 视图体系（全部 Three.js）

| 视图 | 相机 | 内容 |
|---|---|---|
| 3D 主视图 | Perspective + OrbitControls | 当前帧点云、3D 框、几何、网格 |
| BEV 视图 | Orthographic（俯视） | 瓦片底图、高度着色（可选）、3D 框俯视投影、折线/多边形、绘制工具主场 |
| 相机视图 | Orthographic（图像像素系） | 相机图像平面、4D 对象投影（8 角点线框 + 底面填充 + 朝向指示 + 属性标签平面）、点云深度投影点、**可点选**；与所有视图一致，整个场景经单一 WebGLRenderer 渲染 |
| 三视图 ×3 | Orthographic（沿 X/Y/Z 轴） | 当前帧点云正交投影（几何共享，独立 Scene）、对象 2D 轮廓 + 朝向、深度裁剪、可点选 |

- **投影管线**（纯数学，核心库内，无 three）：`world → ego(frame) → camera → 像素`，输出每对象的投影多边形/角点 + 可见性。
- **相机模型注册表**：`ProjectionModel` 接口 = `project(camPoint) → pixel`；内置 `pinhole`（Brown-Conrady 径向+切向畸变）与 `fisheye_equidistant` / `fisheye_equisolid`（theta 多项式畸变，OpenCV fisheye 约定）；manifest 每相机声明 model 类型，注册表可扩展（OCam/ATAN 预留）。
- **视图内属性系统**：属性 schema 挂在 LabelDef 上（key/type/enum/default）；3D/BEV 用 canvas-texture Sprite 徽标（track id + 类别 + 属性值），相机视图用像素系文字平面；点击徽标 → React 定位弹层编辑（schema 驱动控件）→ SetAttribute 命令。密度控制：选中/悬停必显，其余按屏幕投影尺寸阈值，全局开关。
- **自车轨迹**：EgoTrack 提供逐帧 pose；轨迹渲染为 Line + 帧点标记，拾取命中点 → `session.setFrame`；播放跟随 = 相机 target 锁定 ego(frame)。
- **选中传播**：Selection 是全局唯一事实（版本号），任一视图点选 → store 更新 → 全部视图 + 面板同步高亮；hover 是轻量旁路状态（不进 undo）。
- **渲染同步是脏标记增量**：store 变更发 `storeChanged(version, dirtySet)`；`TrackInstanceRenderer` 维护 `entityId → instance slot`，只写变化的 instance matrix；**任何视图不允许直接改数据**，也不做全量重建。

## 7. 交互：显式工具状态机

状态：`idle / marquee / move / rotate / boxDraw(first|second) / polylineDraw / polygonDraw / vertexEdit`。转移表显式声明，非法转移拒绝并返回原因；指针手势由视图适配成归一化事件（屏幕 + 世界坐标）喂给状态机；状态机产出**意图**（intent），由 Session 落成命令。播放中开始编辑 → 自动暂停。

## 8. Session（组合根）

`EditorSession` 装配 store/history/oplog/playhead/selection/tools/scheduler，是 UI 唯一入口：
`load(manifest)`、`setFrame(f)`、`play()`、`undo/redo()`、`applyToolIntent()`、`pick(viewport, screenPos)`、`exportSnapshot()`。UI = 视图装配 + 面板，无业务逻辑。

## 9. 包结构与文件地图

```
packages/core/src/
  events/        类型化 EventEmitter（实例化，非单例）
  entity/        EntityStore（句柄+代数+组件列）
  model/         TrackStore（关键帧 SoA/插值/区间索引）、SelectionSet、LabelDefs
  command/       History、Transaction、OpLog、具体命令
  geometry/      纯数学：vec3/mat4/yaw、OBB 角点、ray-OBB、point-in-polygon
  projection/    相机投影（内外参 + 畸变）、ego/global 变换
  stream/        TileScheduler、FrameBuffer（点云/图像）、BevPyramid、HeightField、PcdParser、PotreeOverlay
  playback/      Playhead（注入 rAF）
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

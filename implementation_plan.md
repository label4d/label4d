# 实现方案

## 工作区结构
- 使用 PNPM Workspace 构建 monorepo，根目录统一 lint、格式化、构建脚本与 TypeScript 基础配置。
- `packages/core`：独立 TypeScript 库，封装标注模型、命令系统、坐标/高度转换、事件总线、资源解码等核心逻辑，导出供 UI/其他应用复用。
- `apps/web-ui`：基于 Vite + React 的前端应用，依赖 `@labelfaster/core`；使用 Tailwind CSS 与 shadcn/ui 构建界面、工具栏与面板。
- 通过 `pnpm --filter` 运行针对性的构建、测试、示例脚本，确保核心库与 UI 解耦开发。

## 架构概览
- `packages/core` 采用 MVC 分层：`models/`, `controllers/`, `services/`, `core/`；不直接依赖 DOM，仅暴露数据与事件接口。
- `apps/web-ui` 负责视图渲染与用户交互，Three.js 分别驱动 3D 点云视角与 2D 俯视视角，UI 层监听核心事件刷新。
- 事件总线（如 `emittery`）在 core 中实现，负责广播标注更新、选择变化、历史记录、动效触发等消息。

## 技术栈与基础设施
- Three.js + OrbitControls + OrthographicCamera 渲染 3D 点云与 2D 俯视场景。
- PCDLoader 用于加载自动驾驶激光雷达 PCD 数据，由 core 封装成 `PointCloudService`。
- Tailwind CSS + shadcn/ui 在 UI 应用中实现响应式界面与组件库。
- 共享配置：ESLint、Prettier、Vitest、Playwright 基于工作区统一维护。

## 核心库设计（packages/core）
### 模型层
- `Annotation` 抽象类及 `PolylineAnnotation`, `RectangleAnnotation`, `PolygonAnnotation` 子类，持有唯一 id、顶点列表、可选高度、变换矩阵、选中状态；提供顶点增删改、克隆、平移、几何重建方法。
- `SelectionSet` 管理多选集合、包围盒、类型筛选，支持单选、多选、清空、批量平移。
- `HeightAwareVertex` 类型封装 `(x, y, z)`，便于 2D/3D 共享。

### 控制器层
- `ModeController` 统筹绘制、编辑、选择、移动、动效等模式，并响应快捷键。
- `DrawController` 处理折线/矩形/多边形绘制流程，支持虚线预览与高度采样（调用高度服务）。
- `EditController` 支持顶点拖拽、插入、删除；拖拽完成生成命令以支持撤销/重做。
- `SelectionController` 实现点击/框选、类型筛选、闪烁触发。
- `MoveController` 负责多选整体平移并输出命令。

### 服务层
- `CoordinateService`：维护图像坐标 ↔ 世界坐标 ↔ BEV 坐标的变换矩阵（读取外部标定参数），供 2D/3D 同步与拾取使用。
- `HeightMapService`：解析 PNG 压缩的 2D 浮点高度图，提供高度采样接口；无数据时返回默认高度 0。
- `PointCloudService`：加载 PCD 数据，缓存点云，触发加载进度与完成事件。
- `PreviewService`：生成绘制/编辑时的临时预览顶点与虚线信息。
- `HighlightService`：根据类型或过滤条件维护需闪烁对象集合，向视图推送动效状态。
- `AnnotationRepository`：负责标注数据的序列化/反序列化、导入/导出。

### 命令系统
- `HistoryManager` 管理命令栈；命令实现 `execute()` 与 `undo()`。
- 具体命令：`AddAnnotationCommand`, `UpdateVertexCommand`, `MoveAnnotationsCommand`, `DeleteAnnotationsCommand`, `ToggleHighlightCommand` 等，覆盖创建、编辑、移动、删除、动效设置。

## UI 应用设计（apps/web-ui）
- 视图组件：`ThreeDViewport`（透视相机 + 点云 + 3D 标注）、`TopDownViewport`（正交相机 + BEV 图像 + 3D 顶点投影）、`PreviewOverlay`、`HighlightLayer`。
- 工具栏与属性面板使用 shadcn/ui 组件，Tailwind 辅助布局；包含模式切换、撤销/重做、导入/导出、类型筛选与动效控制。
- 将 DOM 事件转换为 core 控制器可理解的交互事件（点击、拖拽、框选、快捷键）。
- 高度采样：在 2D 绘制时通过 `HeightMapService.sample(x, y)` 获取高度并更新顶点，保证俯视绘制落地 3D。
- 动效渲染：`HighlightLayer` 根据 `HighlightService` 提供的闪烁节奏调整材质或开关发光效果。

## 数据流与同步
- UI 交互 → 控制器处理 → 更新模型或命令 → 触发事件 → 视图订阅更新。
- 2D 与 3D 标注均读取同一模型；坐标转换由 `CoordinateService` 统一管理，确保点云尺寸与 BEV 图像互相对照。
- 撤销/重做调用 `history.undo/redo`，事件驱动视图重绘与 UI 状态（按钮禁用等）。
- 高度图加载成功后，视图刷新 BEV 背景与高度采样；失败时 UI 层展示错误提示。

## 交互与动效细节
- 绘制状态展示虚线与待插入点（PreviewService 输出），鼠标光标与状态栏提示当前操作。
- 顶点拖拽支持辅助线、偏移量显示；`Shift+Click` 插入点、`Alt+Click` 删除点。
- 框选/多选提供包围盒与计数反馈；整体平移支持鼠标拖拽、方向键微调。
- 动效面板允许勾选类型或自定义规则，触发闪烁、高亮或脉冲动效；可设置持续时间与节奏。
- 快捷键：`Ctrl/⌘+Z` 撤销、`Ctrl/⌘+Shift+Z` 重做、`Delete` 删除、`Esc` 取消当前操作、`H` 快速切换高亮模式。

## 数据与资源处理
- PCD 点云与 BEV 图像异步加载，支持进度回调；加载完成后通知视图与控制面板。
- 高度 PNG 解码可使用 `pngjs` 或 WebCodecs，从 RGBA 通道重建浮点数组；缓存结果并暴露采样 API。
- 标注、高度图、点云之间的配准由 `CoordinateService` 根据输入标定（平移、旋转、尺度）计算。

## 开发迭代建议
1. 初始化 PNPM workspace、根配置、两个子包骨架；在 core 导出最小 API，在 UI 建立依赖。
2. 实现核心模型、事件、命令框架；编写基础单元测试。
3. 完成点云加载、BEV 图像显示、高度图解码服务，并验证坐标转换。
4. 开发折线绘制流程（含高度采样、虚线预览），随后扩展矩形与多边形。
5. 引入选择、多选、整体平移、删除；完善 SelectionSet 与事件通知。
6. 打通撤销/重做命令链路，确保所有交互均被命令管理。
7. 集成 Tailwind + shadcn/ui 的工具栏、属性面板、动效控制；实现 HighlightService 与闪烁渲染。
8. 完善错误处理、状态反馈、快捷键提示；编写文档与示例数据。
9. 覆盖单元/集成/端到端测试，验证高度采样、选择、高亮等核心流程；优化性能与资源管理。

## 测试与质量保证
- `packages/core`: Vitest 覆盖模型、命令、事件、坐标转换、HeightMap 解码、Highlight 逻辑。
- `apps/web-ui`: React Testing Library 验证组件交互，Playwright 或 Cypress 进行端到端流程测试（绘制→编辑→撤销→动效）。
- 性能监控：对大规模点云与密集标注进行压力测试，必要时在视图层采用视锥裁剪、LOD 或节流刷新。

## 后续扩展方向
- 发布 `@labelfaster/core` 文档（Typedoc）与 demo，便于集成。
- 支持多用户协同、任务管理、云端存储。
- 扩展更多标注类型（3D 盒子、体素）、自动化检测辅助与插件机制。

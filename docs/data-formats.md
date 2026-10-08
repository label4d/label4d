# v1 数据格式与坐标

Waymo 离线适配器输出独立的 `labelfaster.normalized-sequence/1` 契约，见 [规范化离线数据](normalized-data.md)。它保留真实时间与完整姿态，不属于这里的运行时 v1，浏览器通过独立的 DatasetProvider 读取 `sequence.json`，不会将它传给 v1 manifest 校验器；打开方式与边界见该文档。

运行时契约定义在 [manifest.ts](../packages/core/src/io/manifest.ts)、[snapshot.ts](../packages/core/src/io/snapshot.ts) 和 [模型类型](../packages/core/src/model/types.ts)。本文说明当前格式；`fixtures/schemas/manifest.v2.schema.json` 是历史 fixture 规范，不能作为运行时 manifest 使用。

## 坐标约定

- 世界坐标为右手 **Y-up**，单位米。KITTI 原始基转换为 `(x, z, -y)`；PCD 写入已转换的世界点，不在渲染时再次转换。
- 4×4 矩阵为列主序。`egoPoses` 是 ego → world；`cameraToEgo` 是 camera → ego。相机光学坐标为 X 右、Y 下、Z 前。
- 框位置为几何中心；尺寸为 `[length, height, width]`，分别沿局部 X/Y/Z。yaw 的长度方向为 `(cos(yaw), 0, -sin(yaw))`。当前框只保存 yaw。
- 帧号从 0 到 `frameCount - 1`，存在区间 `startFrame`/`endFrame` 两端均包含；时间由帧号和 fps 表达。
- BEV 图像列向右为 +X，行向下为 +Z；左上角为 `originX, originZ`，`metersPerPixel` 为每像素米数。

## 序列 manifest

以下是单帧点云的最小资源示例；PCD 文件需另外提供：

```json
{
  "formatVersion": 1,
  "id": "example-recording-v1",
  "fps": 10,
  "frameCount": 1,
  "egoPoses": [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
  "pointCloud": {
    "format": "pcd",
    "urlTemplate": "/datasets/example/pcd/{frame}.pcd"
  }
}
```

`{frame}` 替换为未补零的十进制帧号。URL 由资源加载器按浏览器 URL 规则获取，不自动以 manifest 所在目录为基址；建议生成站点根相对 URL 或绝对 URL。跨 origin 资源需适当的 CORS；Potree 服务还需支持字节 Range 请求。

| 可选字段 | 约定 |
| --- | --- |
| `egoPoses` | `frameCount` 个 16 元素刚体矩阵，或返回同形状 JSON 的 URL |
| `cameras` | 每相机有唯一 id、model、width/height、fx/fy/cx/cy intrinsics、cameraToEgo 和 imageTemplate |
| `distortion` | 相机内字段；pinhole 为 Brown-Conrady `[k1,k2,p1,p2,k3]`，鱼眼为 theta 多项式 `[k1,k2,k3,k4]`；已校正照片不要重复畸变 |
| `bev.image` | url、originX/originZ、metersPerPixel、width/height |
| `bev.tileset` | 同样的范围字段，加 tileSize、含 `{level}/{x}/{y}` 的 urlTemplate |
| `height` | 固定图片及范围或 tileset，高度采样来源 |
| `potree` | `url` 指向包含 metadata.json/hierarchy.bin/octree.bin 的 Potree 2 UNCOMPRESSED 目录 |
| `labels`、`qa` | 标签定义与文档整体 pending/pass/reject 初始状态 |

支持 pinhole、fisheye_equidistant、fisheye_equisolid 投影模型；正式 KITTI 导入使用已校正 pinhole 图像。PCD 加载器支持 ASCII/binary，导入器输出 binary xyzi Float32。其他编码不能仅修改扩展名后使用。

## 标注快照

序列种子使用 manifest 同目录的 `snapshot.json`，导出采用相同的 v1 快照语义。空文档示例：

```json
{
  "formatVersion": 1,
  "sequenceId": "example-recording-v1",
  "frameCount": 1,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "qa": {"status": "pending"},
  "tracks": [],
  "geometries": []
}
```

每个 track 包含 `meta`、`kf` 和可选 `frameAttributes`。规范导出的 `kf` 为 `{count, frames, pos, yaw, size}`：frames 是 Int32Array 原始字节的 base64，其他为 Float32Array 字节的 base64；pos/size 长度为 `3 * count`，yaw/frames 长度为 count。该 v1 实现直接编码 TypedArray 内存，不含独立端序标记。

外部导入也接受 `keyframes` 中同名普通数值数组。关键帧严格按帧号排序，元数据/属性/几何字段应遵循模型类型和运行时验证，不应自行省略必需字段。导入校验序列身份和帧数，阻止跨序列恢复。

## 数据身份与验证

同一序列的照片、雷达、位姿、标定和标签必须来自同一录制，并按同一帧配对。KITTI 标签底面中心要转换为几何中心，rotation_y 沿相机 X 长度轴，标定包括 rectification 与 P2 基线。详见 [KITTI 指南](real-camera-preview.md)。

不同录制或坐标版本使用不同 id；ID 中任意文本后缀不改变 `formatVersion`。浏览器已有标注可能覆盖新生成的种子，因此不要复用 ID 来发布不兼容的坐标变更。

`pnpm fixtures:validate` 检查历史 v2 fixture 的 JSON Schema 子集与时间单调性；`pnpm verify:preflight` 再检查环境与文件校验和。两者都不是运行时 v1 格式验证器，也不能证明真实照片、点云和标签对齐。当前导入与独立参考检查见 [数据工具](../tools/README.md)。

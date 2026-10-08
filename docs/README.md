# 文档导航

文档以当前代码实现为准，未来能力单独放在路线图。开始使用与贡献请先阅读根目录 [README](../README.md)、[CONTRIBUTING](../CONTRIBUTING.md) 和 [AGENTS](../AGENTS.md)。

| 文档 | 用途 |
| --- | --- |
| [实现架构](architecture.md) | 模块边界、Mermaid 架构图、帧呈现与持久化流程 |
| [数据格式](data-formats.md) | v1 manifest、快照、坐标和 URL 约定 |
| [数据工具](../tools/README.md) | Python 导入新序列、下载、重建与测试 |
| [KITTI 对齐与验证](real-camera-preview.md) | 官方预览准备、标定、视图含义和独立验证 |
| [Potree 渲染](potree-rendering.md) | 流式选择、采样、预算和诊断 |
| [PotreeConverter 构建](../third_party/POTREE_BUILD.md) | 本地静态地图转换器 |
| [多数据源接入设计](multi-dataset-design.md) | PandaSet/Waymo 选择、当前限制与待实施架构 |
| [规范化离线数据](normalized-data.md) | 已实现的交换契约、Waymo 适配器、只读浏览入口与验收边界 |
| [路线图](roadmap.md) | 尚未实现的工作与发布前事项 |

旧需求、交付任务书、日期审计、验收计划和 UI 实施记录已由上述当前指南替代；历史内容可从 Git 历史查阅。保留的 v2 fixture/schema 是历史验证输入，不代表运行时已支持 v2。

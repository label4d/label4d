# 贡献指南

[English](CONTRIBUTING.md) | **简体中文**

先读 [中文 README](README.zh-CN.md)、[实现架构](docs/architecture.md)和[数据格式](docs/data-formats.md)。运行时是 v1 本地编辑器，规划中的 v2 行为不是实现契约。面向编码代理的约定在 [AGENTS.md](AGENTS.md)。

## 本地开发

```sh
pnpm install --frozen-lockfile
pnpm dev
```

使用 Node.js 20+ 与 pnpm 8.15.0。Python 工具请安装 uv 并用 `uv run --project tools/py`；不要引入第二套依赖环境。依赖与锁文件的改动要一起提交。

报告问题时请附上相关提交、浏览器与操作系统、数据集序列、帧号、复现步骤，以及预期与实际行为。投影或视图问题附截图会更快定位。用一个小的合成复现，或说明如何获取公开的源数据；不要上传私有数据集。

## 提交改动

- 改动保持聚焦。说明具体的行为变化，以及是如何验证的。
- 编辑器的写操作走 session/command API；离线数值处理用 Python。
- 为数据丢失、帧竞态、坐标错误和交互失效补充有意义的回归覆盖。
- 格式、命令或用户行为变化时，更新对应的当前指南。
- 不要提交生成的数据集、测试截图、凭据或机器相关配置。

## 验证

```sh
pnpm lint
pnpm test
pnpm test:tools
pnpm build
pnpm --filter @label4d/web-ui exec playwright install chromium
pnpm --filter @label4d/web-ui exec playwright test --workers=2
```

只跑与改动相关的检查，并说明跑了哪些。Playwright 占用 4173 端口。真实 KITTI 测试需要本地生成好的资源；请如实说明哪些被跳过，不要声称覆盖了真实数据。涉及数据集改动时，按[数据工具指南](tools/README.md)和[KITTI 验证指南](docs/real-camera-preview.md)来。

旧的 v2 fixture 预检只检查 schema 与校验和。它不能证明某个 fixture 是合法的 v1 运行时输入，也不能证明混合录制之间是对齐的。

## 发布准备

项目采用 MIT 协议；协议全文见 [LICENSE](LICENSE)，第三方与参考数据的归属记录在 [NOTICE](NOTICE)。不要把项目称为生产就绪，也不要在实测覆盖之外宣称规模或性能。当前限制与计划中的扩展见[路线图](docs/roadmap.md)。

改动项目协议、NOTICE 里的归属说明或安全报告渠道，都属于维护者决定：先开 issue 讨论，再改这些文件。

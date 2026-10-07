# PotreeConverter 构建

静态 Potree 地图是可选资源；当前帧 PCD 不依赖转换器。正式导入需要 **UNCOMPRESSED** 编码，浏览器不支持直接读取其他 Potree 编码。完整管线见 [数据工具](../tools/README.md)。

## macOS / AppleClang

需要 Xcode Command Line Tools、CMake 和 TBB。以下命令从本仓库根目录执行：

```sh
brew install cmake tbb
git clone --recursive https://github.com/potree/PotreeConverter.git third_party/PotreeConverter
git -C third_party/PotreeConverter apply ../PotreeConverter-apple.patch
cmake -S third_party/PotreeConverter -B third_party/PotreeConverter/build \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_CXX_FLAGS="-Wno-c++11-narrowing" \
  -DTBB_DIR="$(brew --prefix tbb)/lib/cmake/TBB" \
  -DCMAKE_EXE_LINKER_FLAGS="-L$(brew --prefix tbb)/lib"
cmake --build third_party/PotreeConverter/build --parallel 8
```

导入器默认查找 `third_party/PotreeConverter/build/PotreeConverter`。也可传 `--potree-converter /path/to/PotreeConverter` 或设置 `LABELFASTER_POTREE_CONVERTER`。

[Apple 补丁](PotreeConverter-apple.patch) 提供 Apple 文件 seek、内存/CPU 查询分支和缺失的标准库并行算法回退，同时增加 LAS 打开失败诊断。补丁按既有上游源码制作；上游更新后若无法应用，应检查差异，不要重复应用或忽略失败。转换器及子模块继续遵循各自上游许可证。

Linux 可按 [上游说明](https://github.com/potree/PotreeConverter) 构建，再通过参数指定二进制；这里的 Apple 构建步骤不构成 Linux 构建验证。

## 生成实际序列

从仓库根目录运行完整 Python 管线，确保静态地图、照片、当前帧点云和标签来自同一录制：

```sh
pnpm data:import:kitti \
  --input /data/kitti --sequence 0004 \
  --output apps/web-ui/public/datasets/kitti-0004 \
  --url-prefix /datasets/kitti-0004
```

管线生成世界 PCD、过滤人工框内动态点、BEV、LAS 和 Potree，并写入 manifest。自定义输出应在忽略目录或仓库外。用 `--skip-potree` 可跳过转换器，仅保留点云、相机、标注和 BEV。

HTTP 服务需要支持 `metadata.json`、`hierarchy.bin` 与 `octree.bin`，并正确处理字节 Range 请求。真实 Potree 测试在本地资源缺失时跳过，测试通过情况不能代替对当前服务器实际加载/绘制点数的检查。

# PotreeConverter 构建说明（macOS arm64，无 Docker）

官方仓库已迁移至 `potree/PotreeConverter`（原 PotreeOffice 路径 404）。

```bash
git clone --recursive https://github.com/PotreeOffice/PotreeConverter.git  # 若 404 用 potree/PotreeConverter
cd PotreeConverter
git apply ../PotreeConverter-apple.patch   # Apple 编译补丁（随本仓库提交，见下文）
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_CXX_FLAGS="-Wno-c++11-narrowing"
make -j8   # 产物 build/PotreeConverter
```

依赖：cmake ≥3.16、TBB（`brew install tbb`，若 find_package 失败加
`-DTBB_DIR=$(brew --prefix tbb)/lib/cmake/TBB` 与 `-DCMAKE_EXE_LINKER_FLAGS="-L$(brew --prefix tbb)/lib"`）。
GitHub 需代理时给 git/cmake 加 `https_proxy=http://127.0.0.1:7890`。

## Apple 补丁内容（PotreeConverter-apple.patch，5705 行）

上游未合并，`git apply` 一次即可：

1. `Converter/modules/unsuck/unsuck.hpp`：`fseek_64_all_platforms` 只保护了
   Linux/Win，补 `#elif defined(__APPLE__) constexpr auto fseek_64_all_platforms = fseeko;`
2. `Converter/modules/unsuck/unsuck_platform_specific.cpp`：无 `__APPLE__` 分支，
   在 Linux 分支后补 Apple 实现（getMemoryData 用 sysctl+task_info，
   getCpuData 返回 hardware_concurrency，printMemoryReport/launchMemoryChecker 空实现）。
3. AppleClang 无 C++17 并行算法实现（`<execution>` 头存在但无策略），对
   `src/main.cpp`、`include/PotreeConverter.h`、`include/sampler_poisson.h`、
   `include/sampler_poisson_average.h` 中的 `for_each(std::execution::par, …)` /
   `std::sort(par, …)` 以 `#if defined(__APPLE__)` 退化为串行调用。
4. `Converter/modules/LasLoader/LasLoader.cpp`：laszip_open_reader 返回值未检查，
   加错误日志（可选，便于诊断非法 LAS）。

## 本仓库数据管线

```bash
# 1. 合并世界系 PCD → LAS 1.4（22M 点，流式两遍）
cd tools/py && uv run python export_world_las.py \
  --input apps/web-ui/public/kitti --output /tmp/kitti-world.las
# 2. 建八叉树（UNCOMPRESSED 编码，客户端内置解码器直接可读）
PotreeConverter /tmp/kitti-world.las -o apps/web-ui/public/kitti/potree --encoding UNCOMPRESSED
# 3. manifest.json 写入 "potree": { "url": "kitti/potree" }
```

验证：`packages/core/tests/potree-overlay.real.test.ts`（数据缺失自动跳过）——
层级解析（15483 记录、代理转正、节点点数和 == 总点数）与解码点落盒校验。

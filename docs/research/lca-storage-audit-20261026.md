# LCA 空间检查 · 2026-10-26

初次检查未删除文件；随后用户明确要求处理缓存，实际清理结果见文末。范围为当前 checkout 与代码明确使用的 D 盘 LCA 缓存目录；未扫描其他项目。未读取 secrets 内容。

## 占用

当前仓库约 **16.28 GiB**，另有 `D:/.lca-cache` **1.89 GiB**。扫描时 D 盘可用 **7.23 GiB**，C 盘可用约 **10.09 GiB**。

| 位置 | 逻辑大小 | 说明 |
| --- | ---: | --- |
| `.local-data` | 11.82 GiB | 622 个一级目录，混有日用数据与大量历次测试 profile，不能整目录删除 |
| `release` | 1.35 GiB | 0.2.0 / 0.2.1 / 0.2.2 安装器及一个 win-unpacked |
| `node_modules` | 1.21 GiB | 开发依赖；包含两套 Electron 版本，当前链接为 44.7.0 |
| `art` | 873 MiB | 原图、候选和冻结素材 |
| `.git` | 635 MiB | 历史与对象，不手工删对象 |
| `test-results` | 184 MiB | 验收回执与截图 |
| `out` | 63 MiB | 当前构建产物 |

数值为逻辑文件大小，跳过符号链接 / junction，未去重硬链接；不等于保证释放的磁盘分配空间。

## 第一批建议：仅测试 profile 的浏览器缓存

约 **5.82 GiB（6,252,372,968 字节）**、5,964 个缓存目录。候选来自 UUID 命名的独立 profile 内，路径名限 `GPUCache`、`ShaderCache`、`DawnGraphiteCache`、`DawnWebGPUCache`、`Code Cache`、`Cache`。

例：`.local-data/backup-smoke-222200f1-4317-4c04-918d-64c457ebc9e6/developer/60e19d85-9c10-4c01-afc7-7d68fd4a078e/chromium/GPUCache`。

清理应仅作用于确认是 Chromium 数据目录下的这些缓存，保留同级数据库、journal、storage、报告与真实模型失败证据。UUID 只用于初筛，不能作为删除整个 profile 的理由。日用 `.local-data/chromium`、非 UUID profile、根数据库、`connections`、`journals`、`dsh-home`、`artifacts` 均排除。

来源已核对：`smoke-settings.mjs`、`smoke-onboarding.mjs`、`smoke-life-work.mjs`、`smoke-resources.mjs` 等创建独立 profile，结束时关闭程序 / 服务，但没有移除这些浏览器缓存。这解释了重复回归后空间累积；不应为此删除全部测试证据。

## 第二批候选

| 位置 | 逻辑大小 | 删前需要核对 |
| --- | ---: | --- |
| `D:/.lca-cache/tmp/nspE9C8.tmp` | 1.00 GiB | 10 月 24 日 NSIS 解包残留，含 app-64.7z、7z-out 与 NSIS DLL；确认安装器未使用 |
| 两个 `.local-data/p5-package-<uuid>` | 合计 1.49 GiB | 仅含 win-unpacked 与 builder-debug.yml；确认无需继续使用该测试包，保留验收回执 |
| `release` | 1.35 GiB | 旧 0.2.x 发布产物；决定回滚保留版本，保留 build-receipt 与哈希 |
| `D:/.lca-cache/upgrade-tests` | 633 MiB | 升级测试含 installed、book、project、user，须区分安装文件与测试证据，不整目录盲删 |

两份 p5 测试包的目录：
- `.local-data/p5-package-b66e945c-5843-42c5-b823-f4ed7559d193`
- `.local-data/p5-package-9143e5d2-17b6-4ce2-aa78-1208498dc8a8`

当前进程详细查询 `Win32_Process` 被系统拒绝；可见的 `Get-Process` 路径未匹配到 LCA 可执行文件。这不是“无人使用”的充分证明，真正删除前仍要核对占用、解析后的绝对路径与目录边界。

## 保留与后续维护

本轮艺术候选、用户保留的房间 v9、已采用素材、冻结包、提示词与来源记录全部保留。真实日用存档、未提交代码、测试回执和失败证据也不动。

后续可给测试脚本补“结束后仅清理可再生浏览器缓存”的统一收尾；保留报告与失败现场中的事实文件，并显式提供保留缓存的诊断选项。本次没有修改测试行为。

机器可读数据见 [空间检查证据](evidence/lca-storage-audit-20261026.json)。

## 用户授权后的实际清理

已删除严格位于 UUID 测试 profile 的 Chromium 数据目录下的 5,955 个可再生缓存目录，共 23,169 个文件，逻辑大小 **6,249,028,256 字节（约 5.82 GiB）**。实际允许的父目录仅为 `chromium` 或其 `GPUPersistentCache`；比初筛范围更严格。逐个解析绝对路径、确认在 `.local-data` 范围内、排除 reparse point，并在删除前复核大小与文件数。

删除失败 0，目标残留 0。其余 85,309 个文件核对存在、大小与修改时间，缺失 0、变化 0。日用 profile、数据库、日志、报告、素材与第二批候选均保留。

清理前后 D 盘可用空间从 12,524,564,480 字节升到 18,780,086,272 字节（约 17.49 GiB）；可用空间变化会受其他项目并发活动影响，不与初次审计的剩余空间直接对账。

实际逐目录回执见 [缓存清理记录](evidence/lca-cache-cleanup-20261026.json)。本次只处理已确认缓存，没有修改测试脚本的日常清理行为。

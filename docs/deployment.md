# 开发、运行与打包

## 环境

当前锁定 pnpm 11.24.0，Node 要求 `>=24.14.0`；版本约束以 [package.json](../package.json) 和锁文件为准。原生 Windows 模块需要 Visual Studio C++ 构建工具及 node-gyp 可用的 Python 环境；命令隔离 helper 使用 Windows 的 .NET Framework 编译器。安装后的普通应用不需要这些开发工具。

每个 checkout 单独安装依赖，不共享 `node_modules`。在 PowerShell 中先进入你自己的仓库目录；路径含空格、逗号或 `&` 时加引号。

```powershell
pnpm install --frozen-lockfile
pnpm setup:electron
pnpm rebuild:native
pnpm dev
```

`setup:electron` 确认 Electron 二进制，`rebuild:native` 为当前 Electron 重编译 better-sqlite3。仅安装 npm 包不能证明 ABI 匹配。无需运行 `playwright install`。

```powershell
pnpm build
pnpm start
```

以上为构建后预览。缓存由 `scripts/runtime-env.mjs` 管理：Windows 使用 checkout 所在盘的 `.lca-cache`，其他平台使用 checkout 的 `.cache`。当前交付和原生命令隔离主要针对 Windows，不能把源码可构建视为其他平台已支持。

## 数据与多实例

源码默认保存到 `<checkout>/.local-data`；直接运行安装版时使用 Electron 用户数据目录。`LCA_DATA_DIR` 可为实例指定独立数据根。开发模式另用 `<数据根>/developer/<sceneId>`，不会用正常 profile 的真实 providers。

| 环境变量 | 用途 |
| --- | --- |
| `LCA_DATA_DIR` | 独立数据根，不指向别人的运行库 |
| `LCA_RENDERER_PORT` | Vite 端口，通常为 5173 |
| `LCA_MCP_PORT` | 开发模式本机 MCP 端口，通常为 5175 |
| `LCA_CDP_PORT` | 开发模式 CDP 端口，通常为 9427 |
| `LCA_PROVIDERS_FILE` | 主进程读取的显式 providers fallback 路径 |
| `LCA_MINI_OPAQUE=1` | 迷你窗强制不透明回退 |
| `LCA_TEST_SILENT=0` | 显示自动化窗口；测试默认透明且不抢焦点 |

目录名含 `gpt` 的 checkout 兼容旧端口 5273 / 5275 / 9527。新实例应明确分配端口与数据目录，不依赖目录名隔离。`LCA_TEST_SILENT` 默认只影响测试，正常 dev / start 应可见。

已导入的 `<数据根>/connections/providers.json` 优先于 `LCA_PROVIDERS_FILE` fallback；配置只由主进程读写。不要用 shell 打印其内容。正常的配置入口见 [开始使用](getting-started.md)。

不设 `LCA_DATA_DIR` 的普通安装使用系统“文档”中的“桃子的房间”投影目录；独立数据根使用自己的房间。房间目录包含作用域和数据根身份，不能靠复制另一份房间来迁移数据库。

## 隔离开发模式

在“工具与设置 → 开发与调试”启用并重启，使用明确标记的假模型、合成来源和可控时钟。调试 MCP 需本机随机令牌，CDP 无鉴权，因此只在显式开发模式开启。不要把令牌、连接配置或真实资料发给调试接口。

开发 fixture JSON 只记录受控场景，不等于完整 `.lca-save`。真实配置不导入开发 profile；合成场景不证明真实服务连通。保留的受限展示模式仍由 `LCA_BOOTH=1` 启用，禁用调试和高风险动作，具体门禁由测试验证。

## 检查

```powershell
pnpm typecheck
pnpm lint
pnpm test
```

按改动选择 Electron 场景，例如 `pnpm test:model-routing` 或 `pnpm test:backup`。完整分层、真实调用准入和历史证据见 [测试说明](testing.md)。

## Windows 安装包

先确认当前 Electron 的原生 SQLite 可以加载：

```powershell
pnpm probe:sqlite
pnpm package:win
pnpm test:package --unpacked-only
```

安装器由 `package.json` 版本命名，输出到 `release/Love-College-Agent-<version>-Setup.exe`。当前为 Windows x64 NSIS、未签名；创建桌面和开始菜单快捷方式，安装后不自动启动，卸载不自动删除用户数据。

`--unpacked-only` 只运行包内 EXE，不安装或卸载，报告为 `test-results/package-unpacked-report.json`。`pnpm test:package` 则还会创建、验证并卸载自己的测试安装；发现已有同名用户安装时拒绝覆盖。不要把包内验证写成用户升级验收。

发布应从已提交的确定源码构建，核对构建回执、安装器 SHA、对应包内结果和版本说明。另一台机器安装、真实配置和连续使用分别记录，不复用旧包结论。当前发布基线见 [v0.1.10](releases/0.1.10.md)。

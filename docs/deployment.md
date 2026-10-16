# Windows 部署与第一圈操作

适用 2026-10-16 第一圈源码。安装包的版本、哈希和验收记录见 [Windows 安装包](engineering/windows-package.md)。首次运行与最终画面仍在迭代，本文只描述实际入口。

## 从源码运行

本机使用 Node 24.14.0、pnpm 11.24.0。各 checkout 单独安装依赖，不共享 node_modules。PowerShell 示例：

```powershell
Set-Location 'D:\love, college&agent'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
pnpm store path
pnpm install --frozen-lockfile
pnpm setup:electron
pnpm rebuild:native
pnpm probe:sqlite
pnpm dev
```

本机 pnpm store 已确认在 `D:\.pnpm-store\v11`。Electron 下载、构建缓存和测试安装放 D 盘；不运行 `playwright install`。只安装 Electron 的 npm 依赖不能保证原生 SQLite ABI 已匹配，需要实际探针。

源码数据默认 `<checkout>/.local-data`，安装版使用 Electron userData；可用 `LCA_DATA_DIR` 为实例指定独立目录。GPT 默认渲染端口 5273，其他 checkout 为 5173，可用 `LCA_RENDERER_PORT` 覆盖。开发调试默认关闭，只有显式开发模式才开启 CDP／鉴权本机 MCP。

透明小窗若在显卡上出现黑底，可在启动前设置 `$env:LCA_MINI_OPAQUE = '1'`，强制不透明圆角回退；程序也检测 GPU 不可用、异常退出和可观察的黑角。详情与验收边界见 [迷你窗增补](engineering/pomodoro-mini-update.md)。该增补发生于 22:47 安装包之后，当前请从新源码运行；旧安装包不含它。

## 安装与模型配置

构建 `pnpm package:win`，运行 `release/Love-College-Agent-0.1.0-Setup.exe`。安装不需要系统 Node 或 pnpm；当前 Windows x64、未签名、默认图标。应用数据不写在安装目录，卸载不自动删除用户数据。

正常模式打开“工具与设置”的模型配置入口，选择本机 providers JSON。字段为 `providers.<槽位>.{base_url, api_key, model}`；可用槽位 `chat`、`background`、`chat_google`、`chat_claude`、`privacy`，其他槽位可保存但未必有功能消费者。配置只由主进程读取，保存到数据根 `connections/providers.json`；重启后应用。界面只显示配置状态和已装配槽位名，不显示值。保存成功不代表连接成功。

聊天使用 chat；记忆／摘要使用 background；隔离邮件、资料与私有插件结果使用 privacy。缺少 privacy 或调用失败就停止相关隔离处理，不借用 chat。学校端点尚未提供，因此当前不能承诺真实隔离业务可用。顶层 mail 配置可保存，但运行中的真实邮箱仍明确阻塞，不会因导入而偷偷开始扫描。

源码也可用 `LCA_PROVIDERS_FILE` 指向获授权的本机 JSON。已导入的数据根配置优先于此 fallback。不要将密钥写入 renderer、命令参数、错误输出、测试报告或公开仓库；不要为演示复制参考项目的认证和运行数据。

## 开发演练

“工具与设置”打开开发者模式并重启，进入 `<数据根>/developer/<sceneId>/`。它不读取真实 providers 内容，所有 fake 来源明确标记。展位设置 `LCA_BOOTH=1` 禁止启用调试；准备正式演示时应使用真实依赖，不能把 fake 当实际模型运行。

1. 扫描合成邮件，在候选卡查原文、确认，再导出新确认事项；交付卡打开实际 `.ics` 与 Markdown。
2. 从合成邮件取附件，或原生选择／拖入 UTF-8 文本、Markdown、文字层 PDF；`/privacy on` 后隔离整理，成品只给用户。关闭滤芯时暂存。
3. 用聊天建立合成经历，在“记忆与日会话”检查来源和纠正链，`/compact` 压缩旧完整回合；历史页仍能看原始聊天。
4. 用户确认番茄计划后开始；新专注自动收为迷你窗，点纸片回书本，休息不抢焦点。拖动后保存位置，熄灯暂停计时和后台，不等于睡眠状态。
5. 实际工作成果被她成功看到并进入休息后，羽毛笔状态可到 given；朴素羽毛笔按钮导出私人存档。设置页也有存档入口。
6. 导入 `.lca-save`，核对 incoming 概要后再确认恢复。取消不改现有数据；确认会先自动备份、重启，再恢复原会话。fake 存档只能在 fake profile 恢复。

不要删除真实数据来彩排“空白书本”：使用独立空 profile。`pnpm test:backup` 已覆盖空白 profile 恢复。私人存档含私有证据与资料，当前不加密，不能当公开角色包分发。

## 外部 MCP

在本机编辑标准 `mcpServers` JSON，经设置页原生文件选择导入。每个 server 默认 `allowTools=[]`、`privacy=always`；只把确实授权的精确工具名放进白名单。支持 stdio 的 command／args／cwd／env，或 HTTPS（本机可 HTTP）的 Streamable HTTP url／headers。OAuth 尚未接入。

连接时先确认页面上的 fingerprint，再在原生窗口核对实际程序和参数／服务地址。启动任意本地程序和调用外部有副作用的工具需要使用者理解配置来源；该权限不由模型自行获得。重启后需要重新连接。私有结果缺隔离依赖会在远端调用前拒绝，显式公开的服务才可设置 `privacy=none`。

本机 Student Hub 仅做标准外部进程测试，命令 `pnpm probe:mcp:student-hub` 使用全新测试库、只调用完整性工具，不扫描学校。其他机器需要已有外部项目与 Python 环境；可通过 `LCA_STUDENT_HUB_ROOT`、`LCA_STUDENT_HUB_PYTHON` 指定。它不是本安装包内置的采集能力。

## 检查与交付

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm test:backup
pnpm test:mcp
pnpm test:model-slots
pnpm test:mini
pnpm package:win
pnpm test:package
```

`test:package` 检查 ASAR，运行解包和实际安装后的 SQLite／日志／番茄钟／存档探针，再检查界面重启，最后卸载自己刚建的 D 盘测试实例。发现已有同名用户安装会拒绝覆盖。测试用合成输入或不存在的供应商文件，不执行真实邮箱或模型调用。不要把这些结果当另一台干净机器的验收；该项仍需队友实际复现。

CDP 仅开发模式：GPT 9527／其他 9427；鉴权 MCP：5275／5175。多实例用 `LCA_CDP_PORT`、`LCA_MCP_PORT` 分开。令牌留在开发 profile `debug-connection.json`，不打印或发给模型。安全诊断显示已采集的值，未采集的费用和缓存等显示未提供。
## 最新安装验收（2026-10-17）

最新 NSIS 于 2026-10-17 07:28 基于源码 `6571c05` 完成实际安装验收，位于 `D:/lca-gpt/release/Love-College-Agent-0.1.0-Setup.exe`，238117936 字节；SHA-256 `763c365b563fd5b1285775e5c6c148442376d72bda20c711f7715354e8685b85`，实际签名 NotSigned。解包版／安装版七类探针、普通界面重启、历史照片／引用／恢复及 15 项安装版原生场景（含同档连续链路及普通作品端口）均通过；模型／服务为合成，不是实机 MC 或真实 OCR／TTS 质量验收。测试目录在 D 盘，测试安装已卸载。构建回执 `release/build-receipt.json`，报告 `test-results/package-report.json`；此包替代 07:08 的旧产物，main checkout 的 release 不随 Git 合并更新。详细复现和边界见 [第三圈安装态记录](engineering/package-third-circle.md)。

`pnpm package:win` 重建当前 worktree 的包；`pnpm test:package` 验证该包。不要从 main 目录拿旧 release 代替这次产物。显式 `LCA_DATA_DIR` 的实例把房间投影放进各自数据目录；正常安装、不设该变量时才放“文档/桃子的房间/<作用域摘要>-<数据根摘要>”，目录名含数据根身份，不同 profile 不共用房间。Python 只用于源码／CI 的 ZIP 独立验证，安装后的应用不需要 Python；没有下载 Playwright 浏览器。

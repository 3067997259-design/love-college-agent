# 开赛首批工程记录（2026-10-16）

本轮用户宣布的 0 h 为周五 16:32（GMT+8）。这是本项目赛中独立实现的工程记录；前两个提交在 main 建立，之后使用 `D:\lca-gpt` / `codex/gpt-foundation`，main 只作集成。用户原有的 README、kickoff、tech-design 未提交改动保留，不随代码提交。

## 提交与接口交接

| 提交 | 内容 |
| --- | --- |
| `c3c4bf0` | electron-vite、React、TypeScript、pnpm 脚手架与依赖锁 |
| `eeb4fc8` | 接口：安全快照、展示事件、白名单命令与 bridge v0 |
| `7c444c5` | CI、统一时钟、IPC 校验与最小快照／命令往返 |
| `f6e0378` | 接口：Claude 审阅提出的七项展示字段与证据查阅契约 |
| `46bb31e` | SQLite 源码重编译命令、真实 Electron 持久化探针与 UI smoke |
| `6073e0d` | IMAP 只读探针、主进程凭据读取与隐私窄出口／假模型测试 |

共享入口为 `src/shared/index.ts`，详细交接在 [src/shared/README.md](../../src/shared/README.md)。Claude 开新工作前合入 main 的接口提交；组件通过 bridge 取事实，假场景实现同一个接口。

- `state.ts`：表情／姿势常量、主进程 daypart、mailboxUnseen、卡片时间、活动时间／地点／来源、番茄阶段长度与计划数量。
- `bridge.ts`：用户专用 `readEvidence` 及高亮契约；证据不进通用快照、事件或模型上下文。实际证据存储尚未接入，当前会明确拒绝无来源的查询。
- `commands.ts` / `events.ts`：白名单与展示流；accepted 不代表业务已完成。
- `src/renderer/src/app/connect-bridge.ts`：先订阅、缓冲、取快照与水位恢复。可供界面装配复用。

当前仅接通模式／熄灯展示状态和计时快照，未完成的能力标为 unavailable；这些内存状态尚不构成日志、后台调度或真实番茄钟。daypart 支持主进程提供作息边界，当前使用默认边界，完整作息调度未实现。

## 本机环境与命令

实测 Node `24.14.0`、pnpm `11.24.0`、Electron `44.7.2`（ABI `149`）、better-sqlite3 `13.0.3`。`pnpm store path` 为 `D:\.pnpm-store\v11`。运行 helper 将临时文件、Electron 缓存和应用数据放在 D 盘；未下载 Playwright 浏览器，未运行 `playwright install`。

安装路径包含逗号和 `&`，PowerShell 路径始终加引号。新 worktree 需要单独安装依赖：

```powershell
Set-Location 'D:\lca-gpt'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
pnpm store path
pnpm install --frozen-lockfile
pnpm setup:electron
pnpm rebuild:native
pnpm dev
```

`pnpm dev` 已实际启动 5273 的开发服务器与 Electron，使用已有 Electron 的 CDP 检查 h1 渲染成功、无 console/page error；随后关闭。`pnpm start` 已构建并打开真实窗口，检查后正常关闭。正式构建窗口的 IPC／隔离验证由 `pnpm test:electron` 完成。

| 命令 | 本轮结果 |
| --- | --- |
| `pnpm typecheck` | 两个 TypeScript 配置通过，含单测类型 |
| `pnpm lint` | 通过；业务全局 Date、定时器与 renderer 特权 import 受限制 |
| `pnpm test` | 6 个文件、9 个测试通过；时钟、lint 规则、IPC／订阅水位、界面契约、隐私失败关闭 |
| `pnpm build` | main、preload、renderer 构建通过 |
| `pnpm test:electron` | 真实 Electron 窗口、sandbox/contextIsolation、无 Node、命令往返、事件退订、非法证据引用拒绝通过 |
| `pnpm rebuild:native` | `--build-from-source --jobs 2` 源码重编译成功 |
| `pnpm probe:sqlite` | 原生加载、事务写盘、关闭连接后只读重开一致，通过 |
| `pnpm probe:imap` | 连接阶段失败，详见下一节；不是邮箱读取通过 |

CI 在 push / PR 上运行 frozen install、typecheck、lint、Vitest，不安装 Electron 二进制或浏览器。首个已确认远端成功的 main 为 `071a796`：[Actions 38880371090](https://github.com/3067997259-design/love-college-agent/actions/runs/38880371090)。该次 CI 早于隐私测试提交；9 项是之后的本地结果，后续推送的远端结果需分别查看。

由于下载速度与磁盘限制，已说明并推迟安装 electron-builder、model-viewer、Tailwind；TypeScript 固定 5.9.3，避免本轮额外的大体积原生编译器下载。其余核心依赖已按锁文件安装。尚无安装包产物或可报告的打包命令；第 6 小时安装包目标仍待完成。

## 163 IMAP：连接被重置，尚未读信

只允许主进程读取用户授权的本机配置。worktree 不复制 secrets；运行探针时在本次 shell 指向原 checkout：

```powershell
$env:LCA_PROVIDERS_FILE = 'D:\love, college&agent\secrets\providers.json'
pnpm probe:imap
```

探针固定只允许“桃子”文件夹，配置 `clientInfo` 由 ImapFlow 在认证前发送 ID；打开时使用 readOnly，内容查询由库生成 BODY.PEEK，只取 1 字节用于验证，前后比对 flags。不会打印正文、地址、凭据、原始错误或连接对象；报告只含阶段、布尔值、固定错误分类和允许的错误码。

直连、显式本机 HTTP 代理及限定 TLS 1.2 的诊断均在 connect 阶段收到 `ECONNRESET`。用户告知校园 Wi-Fi 已恢复后，按要求再做一次默认直连，仍为：

```json
{"ok":false,"probe":"imap","stage":"connect","error":"IMAP_PROBE_FAILED","reason":"network","code":"ECONNRESET","authenticated":false,"idConfirmed":false}
```

遵照“再不行就记下来”停止重复尝试。未完成认证，无法验证真实服务器收到 ID；没有打开文件夹，没有获取邮件，不能报告 PEEK／已读状态验证通过，也不能报告邮箱为空。

用户随后指出可能与 Clash 有关。只读检查确认系统代理启用并指向本机 7897、Clash 生成配置 TUN enable 为 true、Meta Tunnel 网卡 Up。故“默认直连”仍可能经过 TUN；显式 HTTP 代理失败也不能排除 TUN 或上游路由影响。没有关闭 TUN 的对照结果，原因尚未确定。未改 Clash、系统代理或网络适配器配置。下一次由用户提供无 TUN／其他网络条件时再重测，不将本次失败判定为授权码错误或 Unsafe Login。

## 隐私边界与未完成项

`src/main/privacy/filter.ts` 的输出仅含枚举、有效 ISO 时间和长度受限的短字段，拒绝额外字段；缺配置、调用抛错、输出非法均失败关闭，没有回退到主模型的代码路径。显式 fake 仅用合成输入进行单测，带 `source: fake` / `trust: untrusted` 标记；未连接真实 privacy 供应商，也未将真实邮件送进任何模型。

后续仍须完成 append-only journal／SQLite 投影、模型按槽位客户端、harness 与插件、番茄钟状态机、正式邮件采集和证据存储、真实隐私供应商、调试 MCP 与安装包。现有测试不证明这些业务已实现，也不证明跨天／恢复验收通过。

本轮按官方 API 独立实现，没有搬入 AIRI／Student Hub 模块或私人运行数据。外部 API 行为核对：[electron-vite 指南](https://electron-vite.org/guide/)、[ImapFlow API](https://imapflow.com/docs/api/imapflow-client/)、[ImapFlow Fetching Messages](https://imapflow.com/docs/guides/fetching-messages/)，并核查安装版本源码的 ID 与 BODY.PEEK 逻辑。

# 透明窗口下的自动化测试安排（2026-10-18）

用户正在冲刺动画短片，测试不应抢窗口、抢焦点或要求人工盯着。现有 Electron 测试默认 `LCA_TEST_SILENT=1`：窗口通过 `setOpacity(0)` 和 `showInactive()` 运行，`isVisible`、布局、截图和 Playwright 操作仍可用；需要看窗口时才显式设 `LCA_TEST_SILENT=0`。

## 分层

### T0：每次代码改动／合并前（无模型）

```powershell
pnpm typecheck
pnpm test
pnpm test:plugins
pnpm test:student-hub-candidates
```

- `pnpm test` 是 76 个文件、543 项单测（本轮结果）。
- `test:plugins` 覆盖本地插件安装／指纹／MCP。
- `test:student-hub-candidates` 是合成 Student Hub SQLite 的真实 Electron 场景，覆盖候选卡、用户原文和重启幂等。
- 失败时先看具体场景，不把单元测试通过当成 UI 或真实模型通过。

### T1：每天一次／较大改动后（无模型，真实 Electron）

按需要从下列中选跑，默认全部透明：

```powershell
pnpm test:settings
pnpm test:providers
pnpm test:campus
pnpm test:mcp
pnpm test:model-slots
```

这些使用合成服务／本机 HTTP，不读真实供应商，也不读取真实邮箱。不要并行运行多条 `pnpm build` 命令：同一 `out/` 会互相删除文件，实际出现过 `EPERM out/preload/index.cjs`；一次只跑一条。

### T2：真实供应商（显式开启，临时 profile）

```powershell
$env:LCA_REAL_MODEL = '1'
$env:LCA_PROVIDERS_FILE = 'D:\love, college&agent\secrets\providers.json'
$env:LCA_TEST_SILENT = '1'
pnpm test:real-model
```

`pnpm test:real-model` 先构建，再顺序运行：

1. 主进程 chat 槽位的最小流式探针（`probe:model`）；
2. 真实 chat 模型调用 `clock.read` 并结束回合（`probe:harness`）；
3. 正常模式真实 UI：临时 profile 发送一句“只回复 OK”，等待真实 assistant 回复（`smoke-real-model`）。

每次使用独立临时 profile，不碰 `data-live-2` 等活动资料；不打印模型回复正文、密钥或地址。2026-10-18 本轮结果：模型 streamed／textPresent 通过，harness `realModel=true/completed=true/toolVerified=true`，UI 真实回复通过，整套约 16–18 秒。报告在 `test-results/real-model-report-*.json`，只含布尔值和计数。

真实模型不可用时测试失败，不回退到 fake 模型；也不把合成 HTTP 测试当成真实模型质量验收。

### T3：真实隐私滤芯（每周／改隐私配置后）

```powershell
$env:LCA_PROVIDERS_FILE = 'D:\love, college&agent\secrets\providers.json'
$env:LCA_TEST_SILENT = '1'
pnpm probe:privacy
```

这是真实 privacy 槽位、合成文件、正常模式的 UI 流程；检查只调用 privacy 槽位、原文不进日志／普通上下文、实际 Markdown 文件和基础事实。2026-10-18 本轮结果：`status=ready`、1 次真实 privacy 请求、基础事实和截止时间匹配、普通上下文为空；报告 `test-results/privacy-live-report.json`。不据此宣称 OCR／整理质量。

### T4：真实来源与交付

- Student Hub 真实只读扫描：`$env:LCA_STUDENT_HUB_LIVE='1'; node scripts/probe-student-hub-live.mjs`。只在确实需要新邮箱检查时运行；使用临时 DB、仅 Coremail、limit 3，不写外部系统。
- 插件现场刷新：在活动 profile 的插件中心启用后自动导入；也可让她调用 `import_student_hub_candidates`。不要把它当成扫描邮箱。
- 安装包：`pnpm package:win`、`pnpm test:package`。安装态验收必须对实际 EXE 跑，不以源码 Electron 代替。

## 建议节奏

短片冲刺期间：

1. 每次合并或修完一个关键路径：T0。
2. 每天一次：T0＋T1 中与改动相关的 2–3 项。
3. 改 Provider／隐私／真实对话路径：T2；改隐私或整理：T3。
4. 临近提交：T4，再补一次 T2 和 T3，最后打包验收。

窗口透明只解决“看不见／不抢焦点”，不解决模型费用、外部写入或数据边界；真实模型测试仍然有界、临时 profile、显式开启。

## 已安装的 Student Hub 候选插件

2026-10-18 已用透明窗口安装到：

```text
D:\lca-live-test\data-live-2
```

安装脚本使用当前 `out/`；从干净 checkout 重装前先 `pnpm build`。安装前设置备份：`backups/settings-before-student-hub-*.json`。当前 profile 从本机 Student Hub 只读库导入了 3 张带日期候选卡；没有扫描邮箱、没有外部写入。

## 2026-10-18 新包与安装结果

- `pnpm package:win` 在仓库路径下失败两次：先是 NSIS 生成的 uninstaller 存根执行异常，之后发现 `C:` 只剩约 124 MB、NSIS 的 280 MB mmap 失败。把输出改到 `D:\lca-release-safe`、把 `TEMP/TMP` 指到 `D:\.lca-cache\tmp` 后构建成功。
- 成功安装包：`D:\lca-release-safe\Love-College-Agent-0.1.0-Setup.exe`，也复制到 `D:\lca-live-test\Love-College-Agent-0.1.0-Setup-new.exe` 与仓库 `release/`。大小 264,350,354 B，SHA-256 `E393FA84AC252643DE83221F2C1064B5CD4BFA45DCDD44299D022222D3FDB1A2`。
- 用 `/S /currentuser /D=D:\lca-live-test\app-next` 静默安装成功；旧 `D:\lca-live-test\app` 已被安装器替换/清理，新安装位于 `D:\lca-live-test\app-next`，数据仍在 `data-live-2`。
- 新安装 EXE 通过候选插件场景（安装、候选卡、用户原文、重启幂等）和真实模型 UI 场景；实际 `data-live-2` 保持 3 张候选卡。
- `pnpm test:package` 仍未跑完整 26 场景：脚本检测到 HKCU 已有 `Love College Agent 0.1.0`，按设计拒绝自动升级/卸载。新包与静默安装采用单独目录和目标 profile 验收；完整安装态回归需在无同名安装的机器/用户上跑。

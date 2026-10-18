# v0.1.7：新版 UI、文案与插件收口

2026-10-18，用户要求构建新的 Release。源码从 `codex/release-0.1.7` 独立构建：先封存当前 main 的应用改动与相关记录，接口提交 `b6a13fd`，实现封存 `72b48fc`；不包含 secrets、私人运行库、存档或未采用的视频工作区。

## 变更

- 新手引导与书页文字重写，填写模型连接入口和完整上色流程。
- 设置六分区、Provider GUI／预设、语音／礼物／邮箱连接卡；连接测试、保存和重启状态分开。
- 插件书签、技能分栏、路径导入、指纹确认；Student Hub 外部插件包与候选卡出口。
- 日常动作迁到日程页、纸色日历、心流目标收起、资料回形针、斜杠补全、羽毛笔与画面调整。
- 安装器与应用版本均为 **0.1.7**；生成桌面和开始菜单快捷方式，安装结束不自动启动。
- 打包与验证脚本按 package.json 读取版本，不再硬编码 0.1.0。增加 `pnpm test:package --unpacked-only`：仅运行打包解包版，不操作现有安装及卸载注册表，报告单独写入 `test-results/package-unpacked-report.json`。
- 操作卡、独立评委／访客／彩排启动脚本纳入源码；本次展示撤去 MC，历史实现保留。

## 验证记录

- 类型、lint：通过。
- Vitest：76 文件、543 项通过。
- 构建前 `pnpm probe:sqlite`：Electron 44.7.2／ABI 149 原生加载及重开持久化通过。
- 12:38 构建成功：源码 `4670183ded9ed70ec8c998122520e37cd9d31267`，`trackedDirty=false`。
- `Love-College-Agent-0.1.7-Setup.exe`：264,364,803 字节，实际签名状态 `NotSigned`；SHA-256 `a070613f3b0d9a5fdeac61b467e07b9fdbc055fc994da4610ed2344326503f5a`。
- `app.asar` SHA-256：`7ac6fcd00555634efdf6700fb0c1fe89eb0a13d0886e87d55bc0a785efa8b126`。直接读取包确认应用版本 0.1.7，检出“给书房添上颜色”“填写模型连接”“模型与声音”“连接与插件”“保存邮箱连接”“添加插件”六处新文案。
- 12:58 `pnpm test:package --unpacked-only`：**33/33 场景通过**，另有 SQLite／日志／番茄／存档／记忆／生活／心流七类原生探针、普通界面重启、历史照片／引用／恢复通过；包内无 secrets／运行数据，原生模块解包检查通过。
- 验证报告：`test-results/package-unpacked-report.json`，`ok=true`、`executionTarget=unpacked`、`installedProbes=false`、`syntheticServices=true`、`realProviderQualityAccepted=false`。此轮使用合成服务和独立测试档，没有读取真实凭据或调用真实供应商。

首轮打包回归在 16 项场景通过后，于 `mini` 的 300 秒总上限超时。只读诊断确认主进程、迷你窗、诊断窗均响应，隐藏书本的 CDP JavaScript 执行等待；对测试窗口关闭后台节流后同一页面立即恢复。验证夹具提交 `2da1ac8` 调整 `scripts/smoke-mini.mjs`：测试启动时对书本关闭后台节流，并给界面定位加 15 秒上限；不修改应用窗口策略、计时或原安装器。首轮报告保留在 `test-results/package-unpacked-first-attempt-0.1.7.json`，随后使用相同哈希包完整重跑通过。

安装器另存 `D:\lca-release-safe\v0.1.7\`，副本哈希再次相符。代码封存前逐文件对照 main 的 65 个已跟踪修改和 23 个未跟踪应用／记录文件，全部与 `72b48fc` 一致；安全 stash `f693e353d71c044d57b5143c4d9caf92d914375a` 保留原始内容后再快进 main，美术／视频等其他未提交工作保留。

本机已有同名用户安装，默认 `test:package` 仍保留拒绝覆盖／卸载保护。本次解包版验证不能称为安装器升级或干净第二机验收；第二台 Windows 的人工安装由用户执行。真实供应商质量、TTS／OCR、长期自主生活质量未因本次发包升级为已验收。

## 交付入口

- [GitHub Release v0.1.7](https://github.com/3067997259-design/love-college-agent/releases/tag/v0.1.7)：安装器、blockmap、构建回执、校验和、打包回归报告和 `LCA-Demo-Kit-v0.1.7.zip`。
- 本机固定副本：`D:\lca-release-safe\v0.1.7\`。源构建目录：`D:\lca-gpt\release\`。
- 操作资料包含第一次配置、三分钟评委讲稿、公开资料样例、三种独立模式启动脚本。脚本的三模式只读预检通过；不等于已建好有真实配置的 J0/J1/V0 演示档。
- Release 保持原仓库可见性；不上传短片、密钥、个人聊天或校园存档。

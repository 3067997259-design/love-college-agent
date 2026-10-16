# 第零圈开发模式验收

2026-10-16。默认关闭，通过“工具与设置”手动打开并重启。`LCA_BOOTH=1` 或主进程 settings 的 booth 标记优先，展位模式拒绝打开。正常模式不开本实现的 CDP/MCP；Playwright 验收进程的 inspector 由测试器建立，验收一律指定不存在的测试凭据文件或合成供应商。

开发模式使用 `<数据根>/developer/<sceneId>/`，不会打开正常模式的日志／SQLite，也不读取真实 providers 文件。chat 是脚本假模型，隐私模型是显式 fake；Rodin、记忆尚未接通的能力仍显示 unavailable，没有伪装真实来源。退出开发者模式后重启回到原数据根。第一圈现已加入明确标记的合成邮箱，入口与原文边界见 [邮箱主线记录](mail-first-circle.md)。正常模式的真实邮箱仍为 blocked。

CDP 默认主 checkout 9427、GPT worktree 9527；MCP 默认 5175/5275，均监听本机。通过 `LCA_CDP_PORT`、`LCA_MCP_PORT` 覆盖以隔离实例。CDP 无鉴权，仅开发模式开启。MCP 是内置 `developer` 插件的服务，停用插件关闭服务。

MCP 使用 SDK 1.32.1 的 Streamable HTTP，地址 `/mcp`。每次启动生成随机令牌，写入开发 profile 中 `debug-connection.json`（只在本机，不入快照、日志或 stdout）。客户端使用 `Authorization: Bearer <token>`；拒绝浏览器 Origin、不匹配的 Host 和无令牌请求。工具输出只取快照、上下文投影和调度队列，附加常见密钥字段打码；没有供应商查询或任意文件读取工具。

工具：`get_state`、`get_context`、`get_queue`、`set_clock`、`inject_event`、`set_fake_model`、`export_scene`、`load_scene`。注入事件明确为 synthetic，只提供当前 inbox 已有的 pomodoro/mail/autonomous 类别；外出／翻页能力尚未实现。假模型脚本支持有界延时、工具调用和文本回复；不消耗真实额度。时钟支持冻结、0.01–3600 倍速度和拨时；改变锚点会重排计时器，正常运行仍使用真实系统时钟。

**场景格式的当前边界**：第零圈为 `development-fixture` JSON，仅保存时钟、模式、假模型脚本与预置场景 id；载入到全新 profile，重启生效，原日志不改写。这不是完整私人存档，不包含聊天、礼物或记忆，也不能据此宣称备份恢复已验收。第一圈按 §5 做 `.lca-save`、SQLite backup、文件哈希和恢复前备份后，再统一格式。预置 pomodoro-demo 在计时器接通后负责生成演示计划。

验证命令 `pnpm test:developer`：真实 Electron 中检查默认关闭、设置开关、独立会话、假模型工具回合、MCP 鉴权与时钟、场景 staging、展位拒绝。另有 Vitest 验证 Origin、投影打码及场景路径隔离。`pnpm test:electron` 同轮复测通过。

此处参考了已安装 MCP SDK 的 stateless server 类型和 transport 生命周期；实现为本工程独立代码，未复制参考项目模块。

第一圈资料入口：独立开发 profile 现有合成附件、文本／PDF 文件 fixture 和 fake 资料滤芯，见 [资料处理记录](documents-first-circle.md)。`/privacy` 在 profile 的设置里持久化，不随开发场景导出；`export_scene` 仍只是 fixture，未升级成私人备份。新建场景使用自己的默认开关。正常模式缺隐私依赖时不能开启隔离整理；当前仅支持暂存。调试 MCP 没有文件原文或成品读取接口，`get_processed_files` 只提供给 harness 查询元数据。

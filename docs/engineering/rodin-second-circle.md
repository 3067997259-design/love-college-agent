# 实时礼物与 Rodin 验收

2026-10-17。接口 `3c1a78c` 已先合 main，依赖单独提交 `05797d5`（model-viewer 4.4.0）。预制羽毛笔与实时生成礼物分开，来源和失败状态不混用。

## 实现

礼物绑定已有、带当时可见来源的 experience 记忆；没有来源不能提议。只允许共享枚举里的物件与装饰，REST 物件描述由独立 JSON 映射，不传姓名、课程、邮件或整段记忆。专注时提交制作，取得合法本地 GLB 才 ready，休息才 given；未配置则关闭。取消只停止本地等待，不承诺上游撤单或退款。

内置 MCP 使用官方 SDK 的 Client、McpServer 与 InMemoryTransport，同在主进程，避免 OAuth 和子进程凭据传递；外部 MCP 客户端保持原行为。REST 提交、状态、下载适配依据 [Gen-2.5 文档](https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5)、[状态文档](https://docs.hyper3d.ai/en/api-specification/check-status)、[下载文档](https://docs.hyper3d.ai/en/api-specification/download-results)。显式 Low／Raw／GLB／18000 面目标，轮询有间隔和截止点；POST 提交不自动重试。

每天最多一次提交，失败、取消和未知结果都占预算。外部花费另记不可被私人存档回退的私有 ledger；已知同 id 使用原任务，未拿到回执的同 id 不自动重发。任务订阅 key 仅在主进程私有文件，不进日志、工具结果、快照、诊断或存档。空 profile 恢复已完成礼物靠本地模型文件；恢复未完成外部任务且没有本机私有句柄时如实失败，不能伪造 ready。

下载不转发 API Authorization、不跟随跳转，只允许可信媒体域或明确本地合成服务同源；有流式字节上限。GLB 检查头、版本、长度、JSON、自包含资源和压缩类型。二进制按内容 hash 落盘，受限 lca-media 协议只提供当前用户／角色日志中拥有的资源；私人存档包含文件和哈希，验证恢复后可重建。

设置页提供朴素来源选择与 3D 预览，Claude 可在此基础上做礼物架。model-viewer 原依赖初始化 meshopt WASM 会违反 script-src；此版只支持 Rodin raw GLB，禁用该可选解码器，不放宽字体或脚本策略。CSP 媒体部分仅增加受限本地协议，以及 GLB 内嵌贴图所用 blob 图片；没有加入外部脚本／模型域。实际生成文件不含压缩扩展。

## 实际验证

- `pnpm typecheck`、`pnpm lint`、33 个文件／155 项单测通过。5 个新增场景覆盖真实 SDK MCP／合成 REST、私有句柄重启、凭据不随下载、私网下载／外链 GLB 拒绝、来源与专注门槛、休息交付、日预算不回退、取消迟到结果、资产所有权与篡改拒绝。
- 构建后 `node scripts/smoke-gifts.mjs` 通过：真实经历入口、UI 提议、专注制作、ready／given 分离、真实 model-viewer load、无控制台错误、GLB 实际存档与空 profile 恢复后重载。生成服务为 fake，3D 窗口／MCP／日志／SQLite／ZIP 为真实代码。
- `node scripts/smoke-electron.mjs` 在加入 3D 依赖后再次通过：首次／重启字体正常，启动零 CSP 违规与控制台错误。
- 用户授权今晚最多 3 次真实提交；本轮仅用 **1 次**。Electron 中通过真实 MCP→REST 提交／轮询／下载，约 **32257 ms**，取得 **1212696 bytes** 的合法 GLB，SHA-256 `d4c48308e51dbc935ecd25673733c9d6b314c1a0475d3ce6a4214f7e38ec3f3e`。这是独立连接探针，不伪称该物件来自用户的共同经历；未再消耗余下 2 次额度。

完整入口：`pnpm test:gifts`（合成生成服务）、`pnpm probe:rodin`（真实付费提交，需本机已配置 rodin 槽位；当晚探针上限 3 次）。本轮没有重试 IMAP，没有重打安装包。

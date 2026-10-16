# 第零圈：日志、投影与执行底座

本轮在 `D:\lca-gpt` 独立实现，未复制参考工程模块。IMAP 保留前一轮的连接阻塞记录，不再重试。

## 追加日志与 SQLite 投影

- `src/main/journal/`：严格事件结构、每会话连续 seq、首行 header、追加写入及 fsync。损坏／半行文件拒绝继续写入，保留原字节，不截断“修好”。
- `src/main/store/session.ts`：`projections.sqlite` 是可重建缓存，键为 user / character / session，journal_seq 是来源水位。启动总是从 JSONL 重放，再写缓存；不会信任旧缓存里的状态。日志成功后缓存写入失败不撤销事实，下次启动重建。
- `src/main/bridge/controller.ts`：模式与熄灯命令先落日志再发布；启动还原持久状态，epoch 每次运行更新。计时刷新不逐秒写日志。
- 会话日志放在 `<data> / journals / <作用域哈希> / <日期>.jsonl`。本轮按上海时间凌晨 4 点划分启动时的日文件；运行中的翻页、夜间整理与恢复存档流程仍待后续实现。
- 原始工具结果只留私人日志。界面拿活动的模板和短字段，模型只拿 visible；原始证据不进这两个投影。压缩只改变模型上下文，原事件和用户聊天记录保留。
- 同数据目录的 Electron 使用单实例锁；两条编码线仍各自使用独立数据目录。

本轮新增命令 `pnpm probe:journal`（只用隔离的合成数据）：在真实 Electron 中验证重启重放、过期缓存重建、删除缓存后重建、作用域隔离，以及原始工具结果不进入投影。测试只删除探针自己的可丢弃 SQLite 缓存，不删除日志。

单测还覆盖原始字节前缀不变、半行损坏不截断，以及压缩后仍保留原事件。Electron smoke 已适配 Claude 的书本根节点，并增加同一数据目录重启后恢复状态／更换 epoch 的检查。

2026-10-16 本功能实测：typecheck、lint、7 个文件／12 项 Vitest 通过；Electron journal 探针各项通过；书本界面的真实 IPC smoke 和重启恢复通过。尚未用真实邮件或模型填充这些测试。

## 模型客户端

`src/main/model/` 实现兼容 Chat Completions 的流式读取，按 index 拼工具参数，只取 content/refusal 和工具调用，不展示独立 reasoning 字段；检测到内联思考标签时拒绝输出。客户端内持有配置，日志回调只给槽位、状态码、固定分类和用量，不给配置值、原始错误或 HTTP 正文；收到的文本还会剔除已知配置值，避免上游意外回显。

每次 429 重新读 Retry-After；5xx／网络按 1、2、4 秒等待，最多重试三次、总等待不超过 30 秒；连续两次 503 或配置错误转向显式提供的备用槽位。已有部分输出或本轮执行过工具后的断流不自动重放。每个请求有 30 秒无数据和 120 秒总时限，全部由统一时钟调度，取消也能打断退避。

隐私槽位强制独立，无备用通道；缺配置保持 unavailable。本轮没有连接真实 privacy 供应商。

新增 `pnpm probe:model`：只发一次很小的合成请求，最多等待 20 秒，不展示回复正文。2026-10-16 已在真实 Electron 主进程读取用户授权配置，用 chat 槽位通过流式请求（textPresent=true、toolCalls=0）；这只证明对话模型连接，不证明工具调用或人物提示已验收。类型、lint 和客户端 6 项单测通过。

兼容格式按官方 OpenAI 文档核对：[流式事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)、[工具调用](https://developers.openai.com/api/docs/guides/function-calling?strict-mode=disabled)。采用既定兼容协议，没有更换供应商、模型或改用另一套 API。

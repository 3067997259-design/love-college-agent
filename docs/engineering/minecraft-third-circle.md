# 第三圈：展位 Minecraft 执行记录

2026-10-17。当前为接口与协议核对阶段，**运行适配与验收未完成**。GPT 继续整个第三圈，Claude 接游戏情境的活动与声音；不修改、构建、启动或接管参考项目的服务。

## 本轮只读核对

阅读 docs/research/mcpfabric-booth.md 后，核对 `D:/mcpfabric` 当前源码 **f2c1296ab011f1c89f254db136dfd90be15059bb**：tools.ts、index.ts、InfoHandlers、ClientWorldSession、WorldSession、LocalPlayerHandlers、ControlHandlers、EventBus、ClientEvents 和导航状态。未读凭据／游戏存档，未调用真实桥；没有复制 Java 或参考编排模块。本项目仍经标准 MCP 独立实现，MIT 来源按既有调研声明记录。

- `get_status`／`list_capabilities` 必须确认 client／集成世界可用，command 和 world_write 均 false；管理工具也要从实际模型工具集中移除。
- `get_self` 直接给 uuid/name/x/y/z；`get_world_session` 的实际字段是 instanceId、sessionId、revision、connected、playerUuid 等。每个 MCP 输入可带 `expectedWorldSessionId`，响应会带 worldSession。不能只靠观察后再发一个未限定世界的动作。
- `navigate_to` 支持 controlSessionId/sequence、8 秒一类短租约；started 不是抵达。应查 `navigation_status` 与新的 get_self 坐标，再决定是否完成。
- 停止优先用本轮 `release_control_session`，配合 `get_process_state` 的 owned=false 验证；不以客户端 RPC abort 冒充原生按键释放，也不发送会清掉其他输入所有者的无条件 stop 来遮盖失败。
- `poll_event_page` 用 streamId、cursor、gap、tail 和 worldSession 去重与换代。开始／重连／换世界只从尾部接新消息；不重播旧聊天，自己的 uuid 回声不触发循环。
- 通用 MCP 文本会遮盖 UUID 这类长标识；游戏需要只在主进程内读取结构化协议并先严格校验，再只发布公共玩家／状态。不能让为此增加的路径绕过 allowTools、privacy 或凭据遮盖。

## 待实现的受限情境

共享接口 MinecraftView 和 minecraft.check/start/stop 是事实／有限授权入口。MCP 的原生连接批准仍先进行；游戏 start 要由书本用户接受观察到的玩家 UUID、附近范围、时限和是否允许聊天。范围数值是实施默认项，并非此前已由用户指定。

预计固定子集：状态／自己／背包／眼前场景、短距导航与核验、普通聊天和受限事件页；不开放管理员命令、传送、给物、世界写入、飞行或无限持续输入。send_chat 前导斜杠、控制字符及同类绕过拒绝。专注／熄灯／停止／断线／关闭使本轮失效，旧请求不能复活；未知的停止状态如实保留且阻止继续。

游戏情境使用新鲜、受限的上下文，不把个人校园资料或原始心流过程带进公开聊天；普通模型工具不能从通用 MCP 路径绕过本轮范围。先用自有本机合成 MCP 验收，再等待操作员准备真正的两个客户端／世界作实机验收。应用存档不能复位外部 Minecraft 世界。

## 当前依赖

语音／真实 OCR 的服务配置信息仍待用户回答，其他工作继续。光学接线已在 1afbc4c 合 main，CI 通过；合并最新记忆新鲜性守卫后，类型检查、光学／记忆服务 16 项定向单测及光学 Electron 再次通过。

已补主进程内部的 `McpConnection.protocol`：只读已批准 allowTools／实际 schema；privacy=always 的连接拒绝结构化旁路，普通模型工具仍走原遮盖路径。具名协议调用在主进程内解析 JSON，断线／取消会拒绝迟到结果；标识校验会拒绝与配置凭据相同的值，普通公开文本继续遮盖。`McpService.tools(excludeServers)` 为后续游戏情境阻断通用工具绕行预留。没有把此对象挂到 AppBridge 或调试 MCP。

本批类型／定向 lint、MCP 7 项单测通过，包含实际本机 MCP HTTP 握手下的 allowTools、schema、字段支持、隐私拒绝和断线检查。**它只是必要的协议底层，不是 MC 已能玩或实机通过。** 游戏状态机、范围／租约、事件和场景仍待下一批。

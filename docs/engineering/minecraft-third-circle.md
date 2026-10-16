# 第三圈：展位 Minecraft 执行记录

2026-10-17。主进程与朴素入口的合成闭环已通过，**真实双客户端与模型质量尚未验收**。GPT 继续整个第三圈，Claude 接游戏情境的活动与声音；不修改、构建、启动或接管参考项目的服务。

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

## 有界控制服务（当前仍未接界面）

`src/main/minecraft/` 已独立实现主进程控制器：新鲜权限／世界／玩家核对，用户确认 UUID 后开轮，目标半径最多 16 格、最多 10 分钟／24 次动作／360 次读取／120 次事件页，每次导航原生超时 8 秒、不疾跑。坐标目标和观察到的玩家位置都检查范围；这是观察守卫，不是原生物理围栏，真实路径绕行与停步延迟仍须实机验收。开始只读事件尾部；stream／world 换代拒绝旧响应，事件去重和自身回声过滤。聊天拒绝斜杠／全角斜杠、控制字符、凭据碰撞。原始通用 MCP 工具对游戏类端点自动隐藏。

停止按当前世界明确释放自己的 controlSessionId，再检查同 id 的 owned=false；未知保持停止未核实，后续同一端点重新核对才能解锁。专注／熄灯／到期／关闭均走释放；中断回执只允许恢复清理，绝不自动连线／继续动作。导航启动不表示抵达，需当前输入仍归自己、导航终止且新坐标距离目标足够近。

本轮 Minecraft 8 项＋MCP 7 项单测、类型／定向 lint 通过，覆盖错误玩家、权限开关、实际 schema 缺字段、作用域、命令型聊天、动作预算、世界变化、迟到结果、停止失败、事件换代、时钟到期与重启无重放。**Minecraft 测试使用注入的合成协议对象，尚未做本机 HTTP 游戏 fixture／Electron 接线或真实双客户端。** 后续需要接独立游戏模型上下文和用户入口，不能据此称为可玩的产品。

## 应用接线与合成 Electron 验收

后续已接通 `MinecraftControls` 朴素设置入口（开发／展位模式）：MCP 原生配置核对 → 观察玩家 → 用户确认 UUID、范围与公开聊天选项 → 书本输入框使用游戏执行器。接口仍为先合 main 的 **1f37779**，`src/shared/state.ts`／`commands.ts`，无需新增 bridge 方法；画面与声音留 Claude。

游戏使用 `<profile>/minecraft/<roundId>` 的独立日志／SQLite／harness；每轮新建，不读普通聊天、记忆、邮件、文件、整理结果、心流或 userName。模型仅有四个受限工具，未允许聊天时移除聊天工具。每轮 8 步／每次输出 800 token／60k 预留预算，尝试计数同时进入普通日志的共享日预算（500k 总／100k 自主）；普通日志不接游戏文本或工具正文。游戏的 `model/seen` 可记忆下标为空，整个目录不进私人存档。结束只给普通上下文代码生成的“尝试次数／观察到的状态／释放核验”，不据此宣称实际完成游戏目标。当前只观察玩家坐标，没有实现背包或眼前视觉。

`pnpm test:minecraft` 本轮实际通过：原生 MCP 配置确认与真实 loopback HTTP、普通 MCP 游戏别名不可用、玩家／范围 UI、fake 模型导航→新坐标抵达核验→公开聊天、事件尾部与自身回声、安静和实际番茄专注停玩、世界变化后停止、私人 ZIP 没有游戏原文、关闭应用写下已核验释放、重启不连接或续玩。`test:electron` 对应脚本（字体／CSP／控制台）、MCP、私人存档及 harness Electron 回归也通过；类型／lint 与 50 文件 269 项单测通过。

关机测试发现并修复了开发时钟过早 dispose 的关闭顺序问题：先结束所有服务取消／释放，再关闭调试运行时和时钟，最后关 fixture 与数据库。不能用 RPC 被取消代替原生释放。

全部游戏数据和模型为自有合成 fixture，没有连接真实 Minecraft、参考服务或真实模型。真实双客户端的配置路径／角色／玩家已向用户询问，未答复前继续其他第三圈任务；不擅自启动实例。实际路径绕行、停步延迟、多人聊天质量和正式展位数据根仍需收口验收。

## 展位 profile 隔离

展位模式现在自动使用 `<dataRoot>/booth`，插件选择、文件过滤、窗口位置、角色关系、所有业务库／日志和私人恢复都使用它；个人模式仍在原根，开发场景仍在 developer/<scene>。普通模式的模型连接配置仍只在主进程装配，不把个人日志／名字复制给展位。旧版未隔离的展位资料留在原根，不自动搬运，因为无法凭旧数据判断它是否属于私人书本；需要的展位存档由操作员显式选取恢复。

`node scripts/smoke-booth.mjs` 本轮通过：同一个 LCA_DATA_DIR 从个人→展位→重启展位→个人，展位无私人名字／消息／计划，展位运行期间私人日志字节未变，展位自己的名字与计划重启保留，回到个人后原书仍在；展位禁用调试 MCP／CDP。开发模式和番茄／小窗 Electron 回归也通过。只使用新隔离目录及合成原始记录，无真实供应商请求。命令为 `pnpm test:booth`。

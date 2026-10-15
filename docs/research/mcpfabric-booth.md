# mcpfabric 调研：双客户端展位接入

日期：2026-10-13。用户已明确互动用于展位／Demo 集市。来源：`D:/mcpfabric`，HEAD `6c390a674b8e5adb1dced481f1d0fea4cfc61a3c` 加本轮读取时的工作区；另读 AIRI game-host 的相关编排。状态：源码调查与接入建议；未启动 Minecraft、MCP server、构建或操纵现有实例。

## 1. 能接入，但需要区分三层

链路是：LCA 通用 MCP 客户端 → Node mcp-server → 游戏内 Fabric HTTP bridge → Minecraft 主线程上的 handler／BotController。

Node 层把 tools.ts 的工具名、输入 schema 与 RPC method 注册成 MCP。普通返回是 text，object 另带 structuredContent；截图返回 image content block。错误带 isError=true。游戏侧负责原版按键、实体交互、导航和部分逐 tick 控制。

本轮 tools.ts 有 **96 个具名工具条目**，README 的“50+”滞后。Node 启动时把整份清单全部注册，不根据当前服务器／客户端 capability 自动裁剪；MCP 已连接或 listTools 成功不代表游戏已进入世界，也不代表每条工具可用。先查 get_status 与 list_capabilities，再用 get_self 核对她的玩家。

来源：[工具清单](/D:/mcpfabric/mcp-server/src/tools.ts:60)、[注册与结果](/D:/mcpfabric/mcp-server/src/index.ts:30)、[实际能力状态](/D:/mcpfabric/src/main/java/dev/mcpfabric/handlers/InfoHandlers.java:17)。

## 2. 两个玩家，只有她的客户端接受控制

现有产品决定是同学和她各开一个客户端，进同一世界，都在展位电脑上；另一台电脑播放短片。研究后的首选拓扑：

| 位置 | 角色 | 接口 |
| --- | --- | --- |
| 她的独立游戏实例 | 安装 Fabric 与 mcpfabric，主持本地集成世界并开放 LAN | 游戏桥 127.0.0.1:25599；LCA 通过 Node MCP 控制这个实例 |
| 同学的独立游戏实例 | 加入 LAN，用键盘鼠标操作另一个玩家 | 无需开启游戏控制桥；不能把 MCP 接到这个实例 |
| LCA | 展位专用档案、长休息状态、有限游戏工具 | 由主进程启动 stdio MCP；与正式路演档案分开 |

让她的实例主持集成世界，是因为一个 bridge 同时有 client 与 server 数据。若她只是加入同学主持的世界，她的 bridge 通常 serverPresent=false，world／entities／players 的 server 工具会返回 no_server。备选是本地专用服加独立 server bridge，但需要两个 MCP endpoint 和正确路由，调试量更大。

**身份与登录仍待实机验证。** 项目已有“同学正版账号、她离线名”的决定，但本轮没有验证 launcher、UUID、LAN 身份认证能否同时接受两名玩家。不能把改昵称视为解决；若集成世界不接受该组合，再核对受控本地专用服方案。两个实例的 gameDir、配置、存档和玩家身份必须分开。

若两个实例都装 mod，默认 25599 会冲突，必须改第二个端口；最小方案只给她的实例装控制 mod。同学键鼠窗口和她的渲染必须共同实测：她的窗口失焦后仍能执行、截图，游戏不会因窗口状态暂停，不能从代码存在推断现场正常。

MCP port 与 Minecraft LAN 游戏端口是不同用途。学生通过游戏端口加入，不需要访问 MCP／控制桥。

来源：[客户端注册](/D:/mcpfabric/src/client/java/dev/mcpfabric/client/McpFabricClient.java:36)、[bridge 配置](/D:/mcpfabric/src/main/java/dev/mcpfabric/config/McpConfig.java:23)、[server 数据限制](/D:/mcpfabric/src/main/java/dev/mcpfabric/handlers/EntityHandlers.java:204)。

## 3. 通用 MCP 客户端必须兑现的契约

| 项目 | 当前实际行为 | LCA 需要处理 |
| --- | --- | --- |
| stdio | Node 启动 dist/index.js；stdout 留给协议，日志走 stderr | 绝对路径；受控 cwd／env；子进程生命周期归 MCP owner |
| token | Node 从 MCPFABRIC_TOKEN 取 token，向游戏桥发 Bearer | 密钥在主进程加密设置，不进日志、渲染进程和存档 |
| HTTP | 25600/mcp 为可选 Streamable HTTP，当前仅绑定 loopback，没有单独 token 校验 | 首版优先 stdio，减少端口和独立服务维护 |
| 错误 | bridge unreachable、unauthorized、no_server 等转成 isError | 保留错误分类，不能显示“她已经做完” |
| 截图 | MCP image content block | 支持图像模型时才传；不支持时明确提示，不能只保留截图描述文字并声称看到了 |
| 取消 | 当前 handler 只把 args 交给 bridge；HTTP timeout 有独立 AbortController | MCP 取消不等于游戏撤销；游戏动作要显式 stop／cancel |
| 事件 | mod 有 SSE，但当前 Node 层主要通过 poll_events 暴露查询 | 不会自动唤醒她；需要 scheduler 定时拉取、去重与预算 |

stdio 配置形状可参考 examples/mcp.json。用于我们应用时将 args 换成 `D:/mcpfabric/mcp-server/dist/index.js`，URL 指向她的 bridge；token 由设置页私下录入。README 例子里“从 log 复制 token”的字样滞后，源码将 token 存在游戏 config 文件，避免在日志打印。

来源：[环境配置](/D:/mcpfabric/mcp-server/src/config.ts:32)、[HTTP transport](/D:/mcpfabric/mcp-server/src/index.ts:126)、[bridge 调用](/D:/mcpfabric/mcp-server/src/bridge.ts:61)、[token 来源](/D:/mcpfabric/src/main/java/dev/mcpfabric/config/McpConfig.java:13)。

## 4. 可以直接用的能力与不能混淆的能力

| 展位动作 | 标准 MCP 原语 | 需要额外完成什么 |
| --- | --- | --- |
| 看自身与背包 | get_self、get_inventory、get_equipment | 判断当前世界／玩家，结果入日志 |
| 看学生在哪里 | list_players、get_player；或 query_entities | 需要集成／专用 server 数据；标成服务器观察，不能说肉眼看见遮挡后的人 |
| 看眼前 | describe_scene、screenshot | 前者主要是准星与射线网格，不是完整自然语言视觉理解 |
| 走到一处 | navigate_to → navigation_status；stop_navigation | started=true 只代表启动；查询终态并读新位置 |
| 说话 | send_chat、get_recent_chat、poll_events | 学生聊天作为不可信数据；前导 / 会成为玩家命令，聊天工具也要阻止未授权命令 |
| 挖与放方块 | break_block、evaluate_harvest、get_break_evidence、place_block | 距离、准星、装备、耗时与结果核对；不以一次请求成功代替世界变化 |
| 容器、物品与合成 | menu_*、read_item、craft_by_recipe 等 | 配方、物品和菜单条件；第一轮展位不必全开放 |
| 战斗、载具、鞘翅 | combat_*、vehicle 原语、flight_* 等 | 参数多、环境条件多；现有飞行严格验收未完成，不作为最小展位必需 |
| 持续跟随学生 | 清单没有独立 follow 工具；AIRI 有 game_follow | 需要重复观察目标、重规划、租约、停止和目标丢失处理 |

当前工具的 annotation 不齐全，例如移动／导航等没有统一 WRITE 标记。因此不能只用 readOnlyHint 自动裁剪权限。展位“禁止管理员权限”也不能只关 enableCommands、enableWorldWrite：还要从工具子集移除 teleport_player、give_item、kick_player、set_gamemode 等管理工具，并约束 send_chat 前导 /。

已定规则仍是对外写入需要批准；“启用 MCP server”只授权启动连接，不自动授权任意游戏副作用。赛中要把本次接受的游戏任务及动作范围接进既定审批机制，不能为节目效果自行绕过。

来源：[导航 schema](/D:/mcpfabric/mcp-server/src/tools.ts:1036)、[聊天 schema](/D:/mcpfabric/mcp-server/src/tools.ts:335)、[导航实现](/D:/mcpfabric/src/client/java/dev/mcpfabric/client/handlers/NavHandlers.java:24)、[AIRI 高层动作](/D:/airi/apps/stage-tamagotchi/src/main/services/airi/game-host/index.ts:449)。

## 5. 长动作、停止与自动交流

最小建议：优先用 navigate_to 这种游戏侧逐 tick 执行的动作，避免模型每一步控制 WASD。一次动作设短租约，启动后只做有限次状态查询；状态和最终坐标满足条件才报告抵达。小范围平坦场地比开放生存流程更容易在展位反复验收。

ControlOwnership 支持 controlSessionId 与递增 sequence；撤销后的同一 session、旧 sequence 会被拒绝。未带 session 的旧调用仍接受，不能依赖模型每次主动填写：若要使用这条保障，由应用执行适配层注入身份和序号，并在停止后拒绝旧任务的新请求。

游戏侧 ClientControlGuard 在断线、退出世界、死亡与控制心跳超时清理输入。默认 heartbeatTimeoutMs=30000；仅控制请求续命，普通观察不会续命。因此一分钟导航不能假设读 status 就能保持控制。第一版宜选短于 watchdog 的动作，或实测并明确配置心跳策略，不通过随意“再按一次前进”维持。

用户按停止、熄灯、恢复存档或关闭游戏模式时，应用要立即停止调度新动作并发送 stop_navigation／stop_movement；正在使用物品等另按开放工具补齐对应 cancel。确认新的状态后再标已停止。当前 BridgeClient 的取消只终止等 HTTP 的客户端时，游戏内异步动作仍可能继续，这一点必须验收。

poll_events 用 sinceId 水位、类型过滤和小批量；去重后再形成 inbox 事件。游戏忙时不会每个 tick 调模型，学生没有新消息也不定时寒暄。世界切换／重连时水位与执行代次一并重建，旧世界事件只当历史。启动 Node MCP 连接本身不会提供这套循环。

来源：[输入所有权](/D:/mcpfabric/src/client/java/dev/mcpfabric/client/ControlOwnership.java:23)、[游戏侧清理](/D:/mcpfabric/src/client/java/dev/mcpfabric/client/ClientControlGuard.java:17)、[事件查询](/D:/mcpfabric/mcp-server/src/tools.ts:1069)。

## 6. 展位最小场景与验收

建议先做一个 30–60 秒互动：学生在游戏聊天里打招呼，桃子读到并回应；学生指一个近处目标，她走过去，查询位置后确认。然后才增加一起放方块等动作。持续追随、复杂战斗和飞行保留后续选择，不把标准 MCP 原语包装成已验证的高层玩法。

开赛后按顺序验证：

1. 两个身份进入同一世界，能互相看见；她失焦时仍持续 tick。
2. LCA 首次批准 MCP 启用；实际 listTools 与选定 Node 构建一致。
3. get_status 指向正确 mod／MC 版本，serverPresent 与拓扑一致；get_self 是她的玩家。
4. 来自学生的新聊天只处理一次；邮件／游戏文本不变成系统指令。
5. 导航到近处，查终态和坐标；碰到不可达目标如实失败。
6. 动作中停止，按键确实释放；断线、超时、重连后旧动作不重新开始。
7. 超过工具步数／token 预算时安全结束；学生连续输入不制造并行控制。
8. 管理工具不在可执行子集中，聊天前导 / 被挡住；游戏正常交互仍遵循任务授权。
9. 每轮结束先停止游戏动作，再恢复展位应用存档，核对角色、记忆和任务。

**应用存档不能复位 Minecraft。** 世界方块、玩家位置、背包、聊天和事件环在外部游戏里；要另定场地复位或世界快照流程。可由操作员在每轮收尾手动复位，不声称导入羽毛笔就恢复整个 MC 世界。

## 7. 版本与证据

本轮 gradle.properties 的 mod_version=0.2.125；1.21.1 最新文件名为 mcpfabric-0.2.125+1.21.1.jar。MCP package.json 版本 0.2.0，而 index.ts 的 PKG_VERSION 仍为 0.1.0，所以握手版本字符串不能证明 schema 或游戏构建一致。

AIRI 最新飞行证据实际记录过“源码支持字段，但运行的 dist/tools.js 仍剥字段”的问题。赛中要固定源码点、构建产物 hash，并从实际进程 listTools 检查字段；不能拿文件存在或旧测试通过代替实际接入验收。

本轮未计算运行 jar 的 hash、未核对正在加载的 jar、未查任何真实 token，也未连接现有服务。这里不是展位 ready 判定。Minecraft 版本、Java、Fabric API、Node 与工具产物应固定成一套后，再做上述双客户端场景。

来源：[版本](/D:/mcpfabric/gradle.properties:29)、[MCP package](/D:/mcpfabric/mcp-server/package.json)、[schema 滞后实例](/D:/airi/docs/fork/evidence/elytra-mpc-live-20261013/README.md:10)。


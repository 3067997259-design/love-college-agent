# AIRI 本地 fork 调研：连续性、证据与恢复

日期：2026-10-13。来源：`D:/airi`，HEAD `b747e8b2b0503b5c9636ad7f432dde1d1592e09c` 加本轮读取的工作区。状态：设计、源码与测试断言审读；没有启动 AIRI、读取私人数据库、调用模型或重跑测试。game-host 等文件存在其他工作留下的未提交修改，不能用 HEAD 链接代替当前工作区证据。

## 1. 真正值得参考的部分

这个 fork 已把原来的角色聊天产品扩展出持续工作、证据裁决、分层记忆、主动考量、日志投影和隔离恢复。它最有价值的经验是：模型可以提议和表达，推进权、完成判定、身份、来源和副作用必须由明确的代码所有者负责。

早期设计文档是历史起点。MEMORY-DESIGN 的“零调用方”“尚未接线”等勘探结论不能描述今天的源码：当前 `chat.ts` 已注入 memory.retrieve、compaction，并在普通对话完成和 Flow 完成后调用 captureTurn。

来源：[设计原则](/D:/airi/docs/fork/DESIGN-PRINCIPLES.md)、[当前接线](/D:/airi/packages/stage-ui/src/stores/chat.ts:822)。

## 2. 持续执行：推进、完成和呈现分开

| 责任 | 当前源码 | 对 LCA 的借鉴 |
| --- | --- | --- |
| 推进与插话 | chat-orchestrator-runtime 的 continueFlow、resumeFlowFromJournal | 同一执行所有者推进，调度事件只入队，不再造一个计划续跑循环 |
| 完成裁决 | flow-completion 的 L1 gate 与 L3 reviewer | 模型说 done 是声明；工具结果、审批等待和失败状态决定实际终态 |
| 日志与任务呈现 | journal、ProjectionRegistry、deriveTaskRuns | 对话、工具活动、计划是同一事件流的不同视图，避免重复展示 |

当前 Flow 的模型步通过 prepareStep 和 onStepResult 设边界；onStepResult 在工具执行与消息更新之后调用，确保下一轮从完整结果继续。它还为角色化活动叙述保留额外微步。我们的设计已采用代码活动模板与单独心流视图，可以省去这类额外模型叙述请求。

完成裁决并不等于所有步骤都经过验证。`evaluateFlowCompletion` 允许模型显式关闭步骤，但返回 unverifiedClosed；审批等待和记录失败不能被声明盖掉。没有计划活动的分析任务允许结束，不能要求每项任务都必须改文件。

任务归属按事件上的 taskId 等印记，不能靠时间区间猜；deriveTaskRuns 也有活动条数和文本长度上限。新项目应从第一天让任务、工具调用和证据有稳定 id，不在聊天界面堆无限日志。

来源：[推进入口](/D:/airi/packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:3329)、[完整步边界](/D:/airi/packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:2853)、[完成裁决](/D:/airi/packages/core-agent/src/planning/flow-completion.ts:1)、[任务投影](/D:/airi/packages/core-agent/src/journal/task-run.ts:98)。

## 3. 记忆：来源、作用域与检索效果

当前 memory store 有抽取、检索、纠正／取代、晋升、向量空间迁移和 dreaming 的代码路径。local-memory 持久层保存 sourceContext、scope、reviewStatus、factStatus、sessionIds；检索后记录访问，晋升排除 superseded／disputed 条目。

这对我们最重要的是三个边界：

1. **经历有原始锚点。** 普通聊天和 Flow 的来源不同。当前 Flow 完成后以任务作为抽取锚点，不能把做过的事挂到后来那句“你还记得吗”上。
2. **用户、角色和世界不能串。** 当前聊天召回游戏事实时会加 worldId、connectionGeneration 等标签，旧坐标与其他世界的信息不能当眼前事实。LCA 的用户／角色 scope 也必须进入查询条件。
3. **写进去不代表能用起来。** 要检查新会话实际召回了哪些 memoryIds，回答或行动是否受影响。仅有检索调用、同一上下文记住一句话，都不证明跨会话记忆。

历史审计曾发现普通偏好被误分成 muscle：普通向量检索排除 muscle，dreaming 也不能自动把它修回来。本轮确认当前 local-memory 查询仍排除 muscle，因此分类契约仍很重要；不据此声称当前抽取器仍有同一错误。LCA 首版已定不做 muscle 和情绪维度，保留事实、经历和取代关系即可。

LCA 也已定用中文两字片段检索，首版不需要继承 AIRI 的 embedding、DuckDB／OPFS、云同步和向量迁移栈。我们参考的是来源、作用域、修订与效果验收；存储仍按本项目 SQLite 方案。

来源：[memory store](/D:/airi/packages/stage-ui/src/stores/modules/memory.ts:574)、[抽取接线](/D:/airi/packages/stage-ui/src/stores/chat.ts:1282)、[持久查询](/D:/airi/packages/stage-ui/src/services/memory/local-memory.ts:347)、[访问与晋升](/D:/airi/packages/stage-ui/src/services/memory/local-memory.ts:473)。

## 4. 主动交流：考量不是空消息

life-mode 把已发生事件压成有限候选，按 consideredThroughSeq 等水位去重；没有新事实时不调用模型。模型通过 self_decide 选择 speak、note 或 silence，只有 speak 被公开发出。若考量期间用户输入到达，迟到的 speak 被丢弃，避免抢话。

这些机制可以指导我们的事件触发、去重和“决定沉默”。但当前 AIRI 的 focused gate 同时阻止社会考量与部分私下 dreaming；Flow 活跃、用户发送中也会 gate。LCA 的专注段要求后台工作和自主活动继续，只推迟正常发言，不能照抄这张模式矩阵。

建议在唯一 scheduler 中分别判断：允许任务执行、允许世界结算、允许后台模型、允许公开发言。专注与熄灯产生不同组合；恢复期间再加副作用冻结。每项判断由现有产品规则导出，不另造多套调度器。

life-mode 不等于完整世界泡。本轮未发现它能直接满足我们“按真实时间外出、带物、离线一次结算、恢复不结算空档”的契约；这些仍由 LCA 独立实现。

长期目标层另有 wake → 本地状态检查 → 主进程 claim 租约 → 一次有界 Flow → 释放租约的路径，并检查恢复 gate、单 Flow 槽位及环境变化。值得参考的是醒来后重新取得执行权，而不是定时器直接恢复旧动作。首版不搬长目标系统，也不把这条接线视为世界泡验收。

来源：[模式 gate](/D:/airi/packages/stage-ui/src/stores/modules/life-mode.ts:638)、[迟到发言处理](/D:/airi/packages/stage-ui/src/stores/modules/life-mode.ts:770)、[长期目标](/D:/airi/packages/stage-ui/src/stores/modules/long-goals.ts:1)、[测试断言](/D:/airi/packages/stage-ui/src/stores/modules/life-mode.test.ts:89)。

## 5. 备份恢复：先核验，再换数据，最后决定副作用

当前 data-backup 把各数据 owner 的稳定快照收成包，manifest 声明 coverage、missing、prerequisites，并明确 credentials=excluded、outbox=held。包检查覆盖版本、路径穿越、Windows 大小写碰撞、额外文件、展开大小和 SHA-256。

restore-gate 将“初始化恢复完成”与“允许外部副作用恢复”分开；持久 effectsHeld 在重启后仍约束社会考量、执行和交付。导入一份旧存档，不应自动重新发送、继续旧命令或启动旧后台活动。

LCA 不必继承 AIRI 的多域同步 outbox，但必须保持同一原则：校验失败不动现有数据，替换前保存当前快照，恢复后所有投影来自同一代数据，旧任务不能带旧身份继续执行。SQLite 文件、日志、礼物和素材是一个一致快照；不能分别取不同时间的副本。

羽毛笔恢复的验收应包括：原始记录仍在；角色与用户归属一致；最后一次真实工作、礼物、日记和带回来的东西可查；导出到恢复之间没有虚构新经历；需要重新配置的凭据被明确提示。让模型复述一段摘要仅能证明该摘要进入上下文，不能单独证明完整存档正确。

来源：[备份 owner 汇集](/D:/airi/packages/stage-ui/src/stores/data-backup.ts:45)、[manifest 与校验](/D:/airi/packages/stage-ui/src/services/data-backup.ts:1)、[副作用 gate](/D:/airi/packages/stage-ui/src/services/restore-gate.ts:1)。

## 6. 立绘与 MCP 的边界

Tachie 提供完整静态表情图的包加载、尺寸一致检查、neutral 回退和透明画布；README 明确不支持分层贴片、嘴型和骨骼控制。LCA 的姿势、眼睛与嘴贴片需要自己的格式和组合契约，不能把 .tachie.zip 当作现成实现。

AIRI 的 Minecraft 主路径是 game_* → Eventa → Electron game-host → mcpfabric，而不是旧 integrations/minecraft 的 Mineflayer。game-host 包含持续跟随、租约、世界身份、服务器／客户端双端点和动作后验核对，属于大量已有编排。LCA 用标准 MCP 接入外部 mcpfabric，不搬这个 host；能力差异详见 [MC 调研](mcpfabric-booth.md)。

通用 MCP 层还有值得直接学习的边界：模型可见名与 server 的原始工具名分开映射；工具名非法字符、长度和碰撞由代码处理；调用参数保持 JSON 对象，不再编码成一层 JSON 字符串。跨 IPC 的取消用 requestId 关联，再由主进程转给 MCP。源码中“工具不可用”的 fallback 是显式错误，不能继续给模型留下可成功调用的假象。新实现沿用这些原则，名称约定仍由自己的客户端统一决定。

来源：[Tachie](/D:/airi/packages/stage-ui-tachie/README.md)、[game-host](/D:/airi/apps/stage-tamagotchi/src/main/services/airi/game-host/index.ts:449)、[MCP 名称与对象参数](/D:/airi/packages/stage-ui/src/tools/mcp.ts:179)、[MCP 取消契约](/D:/airi/packages/stage-ui/src/tools/mcp.ts:37)。

## 7. 赛中先验证哪些场景

| 场景 | 应能观察到的结果 |
| --- | --- |
| 多步工作中插话、停止 | 下一步看到新要求；取消有终态；旧任务不在之后偷偷重启 |
| 只读任务完成 | 可正常结束，不伪造修改证据；未验证部分如实标注 |
| 专注时后台工作结束 | 成果入库，画面更新；正常发言留到休息 |
| 新会话问起昨天的真实事 | 有非空且正确的记忆／日志来源，回答受来源约束 |
| 纠正旧事实 | 新事实生效，旧条目保留取代关系 |
| 隐私邮件被引用回忆 | 主模型仍只得到当时获准看到的内容 |
| 导入存档后重启 | 数据和投影一致，旧外部任务与通知不自动执行 |
| 损坏／越界存档 | 恢复失败，原数据仍可用 |

本轮只读测试断言，包括 flow-completion、life-mode、data-backup 与 restore-gate；历史运行记录与本轮源码调查分开。本地最新鞘翅 [证据首页](/D:/airi/docs/fork/evidence/elytra-mpc-live-20261013/README.md:3) 仍记录 M7 未通过，不能把局部通过推广为展位稳定性。


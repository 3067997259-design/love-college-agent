# dsh 调研：插件怎样构成 harness

日期：2026-10-13。源码固定点：`d743267388641bc76f17c45ce8b4c231aed1d32c`，研究路径 `D:/deepseek-harness-research-20261013`。状态：源码与测试断言审读，未运行 dsh、安装依赖或调用模型。这里的 LCA 结构均为建议，赛中独立实现。

## 1. “一切皆插件”的准确含义

dsh 的模型适配、工具注册、会话日志、提示组装、agent 身份和循环本身都是插件。循环不通过 import 各种业务工具工作，而是依赖服务接口。`AgentLoop.static inject` 明确列出 `agents`、`sessions`、`llm`、`tools`、`systemPrompt`、`sessionProjections`。

这仍然需要一个能装插件的宿主：Cordis 的 Context、服务注册、依赖和生命周期。可以把业务内核都插件化，但服务装配与生命周期不能凭空消失。“只有插件”描述的是功能归属，不能解释成只写清单、没有执行循环。

来源：[架构](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/architecture.md)、[AgentLoop 实际依赖](/D:/deepseek-harness-research-20261013/packages/core/agent-loop/src/index.ts:341)。

## 2. 四种机制足以指导我们的加载器

| 机制 | dsh 的落点 | LCA 首版需要什么 |
| --- | --- | --- |
| 服务 | 稳定的 `ctx.tools`、`ctx.llm` 等键，定义与提供者分开 | 官方模块依赖接口；模型、存储和假依赖能替换 |
| 依赖 | `inject` 声明，依赖就绪才激活 | 缺服务、重复服务、依赖环明确报错；不要静默启用半个插件 |
| 注册副作用 | `ctx.effect()`、`ctx.on()`，注册返回 disposer | 工具、指令、模板、定时任务和家具贡献能随插件卸载清理 |
| 事件 | `emit`、`serial`、`waterfall` 等显式分发模式 | 观察通知与会改变执行结果的控制链分开 |

`waterfall` 实际是围绕 `next()` 的中间件：不调用 next 就能截断后续。因此普通拦截链的顺序会改变结果。不能把“最后总有隐私过滤／审批插件”当成不可绕过的保证。

首版建议只开放已经需要的贡献接口：工具、指令、skill、模型用途、配置描述、活动模板、表现声明、地点目录。通用循环钩子仍不对外开放，遵守技术方案 §3.13；调度、权限和投影的扩展先由官方受控模块使用。

来源：[Cordis primer](/D:/deepseek-harness-research-20261013/docs/cordis-primer.md:7)、[事件实现](/D:/deepseek-harness-research-20261013/vendor/cordis/src/events.ts:27)、[生命周期实现](/D:/deepseek-harness-research-20261013/vendor/cordis/src/fiber.ts:181)。

## 3. 我们需要的最小装配关系

| 官方插件／服务 | 负责什么 | 依赖 |
| --- | --- | --- |
| store、clock、journal | 数据持久化、唯一时间来源、事件追加 | 宿主提供的受限主进程能力 |
| projections | 对话、上下文、任务和证据的投影 | journal |
| model | 分用途流式模型、通道切换、用量 | 加密配置、clock、journal |
| tools | 注册、参数检查、权限和结果提交 | journal、官方权限策略 |
| context | 人设、关于你、记忆、当前状态 | projections、memory、world |
| harness | turn／step、inbox、取消与有界推进 | model、tools、context、journal |
| scheduler | 唯一的到时事件与后台安排入口 | clock、store；把事件送给 harness |
| IMAP／编码／Rodin／MCP | 具体能力及相应家具、配置和模板 | tools、相关服务 |
| developer-mode | 假依赖、场景、内部可观测性 | 官方受限调试接口；不接密钥接口 |

这张表是责任划分，不是提前固化包名、目录或类型定义。底座插件缺失时应用应明确停止相关功能；不把日志、权限等必需服务做成用户可以随手关闭的普通装饰。

首版外部代码插件只在用户确认后作为可信主进程代码加载。清单里的权限声明不约束任意 Node 代码；若需要防恶意插件，要另有进程与 OS 边界。表现层继续只接 JSON 和图片，渲染进程不执行插件代码。

## 4. 一个回合如何被插件共同完成

从 `agent.ts` 的真实执行顺序提炼：

1. 追加 turn/start；在步边界领取 inbox 输入。
2. 组装提示与工具，允许 pre-step 拒绝或改写输入。
3. 追加 step/start；确定实际模型路由。
4. 将获准输入和模型配置记入日志，从日志导出并冻结本次请求。
5. 流式生成；提交完整回复或失败尝试。
6. 工具经同一执行管线运行；追加调用与结果。
7. step/end；有工具结果待交回或插话则继续。
8. 准备结束时执行 turn-stopping；如它注入新输入则继续，否则追加 turn/end。

两个值得保留的细节：输入被拒绝或移空时可以有回合而没有模型步；工具执行中断时要补齐尚未得到结果的调用，不能留下模型历史里“有 call 没有 result”的悬空关系。

dsh 的最新 inbox 将 next-turn 与 next-step 分开，并以持久投影保存待处理输入。我们首版可以简化队列形式，但必须定清插话、取消、保留队列和恢复的语义，避免停止后旧任务突然复活。

来源：[循环](/D:/deepseek-harness-research-20261013/packages/core/agent-loop/src/agent.ts:298)、[inbox](/D:/deepseek-harness-research-20261013/packages/core/agent-loop/src/inbox.ts:74)。

## 5. 权限、超时与结果需要执行处保证

dsh 工具管线包含参数校验、pre-execute、审批、单调 guard、实际执行、post-execute、结果定稿及不可变结果通知。`tools.guard()` 的拒绝不能被另一 guard 强制改成允许；这比只依赖中间件顺序稳。

对我们的应用：安全底线在真正执行工具的路径检查，UI 按钮、普通对话、心流、MCP 和将来的分身都走这条路径。工具被隐藏不等于无法执行，工具 annotation 也不等于权限策略。

超时插件组合 AbortSignal 后等待工具停止，不用 Promise.race 把仍在执行的副作用遗弃。模型取消、子进程终止、远端长任务撤销分别需要提供者兑现；无法确认时结果写“未知／未确认”。Rodin 这类真实外部任务取消等待后仍可能完成，需要保存任务 id 并照实查状态。

dsh 的 repeat-tool-reminder 是提醒插件，默认在 3、5、8 次重复时注入提醒，**不会硬停止**。LCA 已定“相同调用第 3 次停止”，不能把这个参考实现误认为我们要求的守卫。

来源：[单调 guard](/D:/deepseek-harness-research-20261013/packages/core/tools/src/index.ts:1133)、[实际执行入口](/D:/deepseek-harness-research-20261013/packages/core/tools/src/index.ts:1375)、[合作式超时](/D:/deepseek-harness-research-20261013/packages/guard/timeout-policy/src/index.ts:1)、[重复提醒](/D:/deepseek-harness-research-20261013/packages/guard/repeat-tool-reminder/src/index.ts:1)。

## 6. 日志、心流和测试的借鉴

dsh 约束是“模型见到的内容能从日志重建”；会话投影折叠已提交事件。工具的 todo 插件也是整表快照写事件，再由投影取最新值，不另造一份与日志冲突的权威状态。

LCA 还需要隐私分层：日志中受保护的原始工具结果，不都具有进入主模型的权限。心流冻结前缀、退出后工作摘要、旧页回忆应明确记录各自可见区间和来源；复用同一投影权限规则。日志保全与模型全量可见是两回事。

可以从参考测试提炼赛中验收条件：

- 从日志重建实际模型请求，验证插话、压缩、换模型后的内容。
- 停止发生在模型流、工具运行、审批等待时，终态均明确；取消后排队工作按既定策略保留或丢弃。
- 插件卸载后工具、监听、定时任务和家具贡献都消失；正在运行的操作先停止再释放依赖。
- 超时不能产生后台悬空副作用；停止后的迟到结果不推进旧任务。
- 通过真实加载器组合插件验证一次完整场景；单独给某个函数传 mock 不足以证明装配正确。

本轮只审读 [cancel 测试](/D:/deepseek-harness-research-20261013/packages/core/agent-loop/tests/cancel.spec.ts)、[请求重建测试](/D:/deepseek-harness-research-20261013/packages/core/agent-loop/tests/request-reconstruction.spec.ts)、[退出刷盘测试](/D:/deepseek-harness-research-20261013/packages/core/agent-loop/tests/shutdown-drain.spec.ts)，没有执行这些测试。

## 7. 首版取舍

参考依赖、可撤回注册、执行管线、日志投影和组合验收。首版不复刻 Cordis 的全部作用域、隔离 realm、HMR、YAML 表达式、配置叠层、npm 插件管理、PTC、多后端 SDK 和格式迁移体系。我们的函数插件／服务接口赛中独立设计，保持足够小，先让全部官方功能实际经过它。

dsh 的 [sdk-minimal 装配清单](/D:/deepseek-harness-research-20261013/packages/bundle/sdk-minimal/cordis.patch.yml) 很适合查“少了什么服务就不完整”，但它仍包含终端、sandbox 等编码产品选择，不是我们的首版依赖清单。dsh 当前为快速迭代的开发预览，固定 SHA 比追随最新 API 更适合比赛期间查阅。

dsh 的 MCP 插件还把 server instructions 加入已记录的系统提示，这是它的产品选择。LCA 已定外部内容是数据；不能未经审查就把外部 server 自述、资源内容和远端提示升级为系统权威。可以借鉴稳定名称、重连、取消与多种 content block 的处理，而保留自己的信任分层。来源：[MCP 客户端契约](/D:/deepseek-harness-research-20261013/packages/mcp/mcp-client/README.md:1)。


# 迁入评审：Agent Browser 的任务内网页阅读与按需截图

2026-10-26，评审人 Codex，按 [迁入规格 v0.1](../plugin-migration-spec.md) 和 [模板](../templates/plugin-migration-review.md) 完成。本文承接 [观察信息量补评](agent-browser-observation-followup-20261026.md)。仅审公开源码、官方文档和当前 LCA 工作区；未安装、执行上游代码、连接浏览器、请求模型或改运行代码。

**结论：值得迁入，推荐 M1 外围适配，当前决策为“先验证”。** 保留 Agent Browser 的浏览器执行后端，LCA 自写有限工具、对象授权、来源和图像出口。第一阶段是“在本次任务专用浏览器中打开指定网页，读取正文 / 结构，必要时补局部截图”；等级 F2。接管用户日常浏览器、输入与提交另行评审。主模型、DSH 回合、审批、番茄节奏和交付入口仍按 LCA 决定。

## 1. 证据矩阵与结论卡

| 层次 | 已核对 | 边界 |
| --- | --- | --- |
| 上游 | `vercel-labs/agent-browser`，commit `6d6270059bfa34b39719d218486dc9acc7d82823`，package / Cargo 均为 `0.39.3`；关键源码片段、配置、安全、许可与依赖声明 | 源码固定点；没有 npm 包、Windows EXE 或 Chrome 制品 hash，不证明发布包等同于源码 |
| LCA | HEAD `711af30d0299141d5830d78b51090dd195f9cb31`，dirty；声明 DSH `0.2.1-rc.2`、Electron `44.7.0`、Node ≥24.14、pnpm 11、Windows | 审查当前文件，hash 见证据；不是干净 commit 构建或安装态结果 |
| 外部契约 | 上游 MCP、CLI、页面读取、截图、session、Windows 进程寿命；Apache 第 4 节；Playwright 文本 / 截图接口 | 上游测试代码和文档均不计本轮运行通过；并非全仓安全或全部依赖许可审计 |
| E0–E6 | E0 所列审查完成；E1 包装、E2 激活、E3 合成、E4 真实功能、E5 生命周期、E6 发布均未测 | 不发布“可直接导入 / 已兼容 / 更省 token”结论 |

源码文件、blob SHA、审查范围及 LCA 文件 hash 见 [证据索引](evidence/agent-browser-migration-review-20261026.json)。

| 字段 | 决策 |
| --- | --- |
| 用户结果 | 在书页请求阅读网页 / 表格 / 图表，得到带网页来源、观察范围、时间和缺失提示的答复 |
| 保留 | 当前页 DOM 读取、局部文本、紧凑结构、元素引用、普通 / 裁切 / 标注截图、专用浏览器与关闭能力 |
| 首阶段排除 | 日常 profile、自动发现浏览器、共享 CDP、登录凭据、表单输入 / 提交、上传下载、任意 eval、cookie / storage、网络抓取调试、录屏、WebMCP 调用、cloud provider、上游 chat / dashboard / 插件系统、自动业务恢复 |
| 路线 | M1：固定 Windows 原生 CLI + LCA main 的窄适配；先不 fork Rust，不复制整套 skill；M0 原样不成立 |
| 流程影响 | F2：新增网页对象授权、图像结果和有限状态投影；涉及 U1–U8，控制权不转移给后端 |
| 决定路线的未知项 | 特定页面身份 / 图片关联能否可靠核对；独立 daemon 的停止与资源核实；DSH 图像投影和退役；限制域名后实际页面覆盖 |
| 维护与许可 | 后续适配维护人未认领；主代码 Apache-2.0 路径明确，实际 EXE / Rust 依赖 / Chrome 分发待核对 |

## 2. 用户价值与完整流程

| 项 | 判断与依据 |
| --- | --- |
| V1 真实用途 | 成立于用户明确提出的“低冗余文本，细节再截图”；验收场景为读文章、比较网页表格、解释图表或 canvas。实际日用频率未知 |
| V2 增量收益 | 预期成立：现有 web_fetch 不代表渲染 DOM 与视觉状态；截图能补文本缺失。已有 API / 校园连接能完成的任务继续走专用能力 |
| V3 流程适合 | 有条件成立：浏览器只执行 DSH 本次工具要求；LCA 书页发起、等待、停止和交付，不再引入浏览器主 agent |
| V4 可持续 | 可限定版本、范围和退出路径；上游变化快，Windows 制品和 Chrome 组合需维护。需在进入正式实现前认领维护人 |

| 步骤 | 当前 LCA | 迁入后的行为与所有者 |
| --- | --- | --- |
| 触发 | 用户在书页提出任务，DSH 使用已有工具 | 同一入口；main 根据用户任务授予本次网页对象，创建独占 session。启用后端连接不自动开启网页或后台工作 |
| 上下文 / 权限 | 项目、来源、隐私路由和逐步额度由 LCA 绑定 | 同时绑定 URL / 允许 origin、页面身份、任务和调用者；先核对获取权限，再核对内容可发给哪个模型 |
| 执行 | DSH 决定步骤、工具与模型调用 | DSH 请求有限 `open / observe / read / capture`；main 校验并构造固定 CLI 参数，后端不规划任务、不调用新模型 |
| 等待 / 停止 | 沿用工具活动、审批、停止和失败旁白 | 停止先撤销 lease、拒绝新调用及迟到结果，再关闭本次 daemon / Chrome；未核实清理显示待核对。停止不撤回已发网络请求 |
| 核实 / 交付 | 工具与实际结果证明完成，书页交付 | 页面身份和范围核对后才使用文本 / 图；输出“看到了什么、没看到什么”，工具退出 0 不等于资料完整或任务完成 |
| 专注 / 熄灯 | 专注安静陪伴、休息交付；熄灯暂停 | 不抢浏览器焦点、不弹第二个工作台；专注不自动禁止已获准工作，沿用现有规则；熄灯、换项目、停用撤销本任务并清理 |
| 后续 / 恢复 | 第三方内容按授权退役，不重放批准 | 文本、截图和派生内容使用同一来源 lease；下一回合 / 重启按既有来源规则退出模型投影。恢复只核对旧资源，不重新导航或恢复登录态 |

成功例：用户给出课程公开统计页，DSH 读取表头与数值，发现趋势只有 canvas 才捕获图表区域，在同一回合说明趋势和出处。失败例：目标跳到未授权 origin、页面身份变化、图像路由不可用或截图读不清时，返回具体缺口，不声称已经看过图，也不接管其他页面兜底。

## 3. 上游能直接复用什么

| 能力 | 源码事实 | LCA 使用约束 |
| --- | --- | --- |
| 结构观察 | snapshot 有 interactive、compact、depth、selector；原生实现维护 refs 并追踪 iframe 文档；MCP 默认 interactive=true | 操作定位用紧凑结构；读正文 / 表格不能机械只保留交互项。后端 refs 不等于 LCA 授权 |
| 正文与局部文本 | 不带 URL 的普通 read 读取当前页 DOM；get text 读取指定对象 | 禁止首阶段模型向 read 传 URL、llms、requireMd 等切换数据路径的选项；后两项即使无 URL 也可能转 HTTP 获取 |
| 图片 | selector 截图、标注、PNG / JPEG、ifChanged；标注会临时向页面注入 overlay | 默认目标区域或视口，按需标注。截图与结构不是原子快照；标注 ID 必须与本次 refs 核对 |
| MCP | 有 stdio MCP；core 为 29 个工具，包含 eval、输入、切 tab；每个工具还增加 session、namespace、restore、extraArgs 等通用参数 | 工具名白名单不足以锁定页面和授权；不能直接把 core 当只读能力，也不能让模型选择这些作用域参数 |
| 生命周期 | CLI 请求可启动独立 daemon；Windows 自有 Chrome 有 Job Object，headless 用 private desktop；session info 提供 daemon PID 等元数据 | 复用实现，但必须核对本次 daemon 的 PID / 启动身份。关闭 MCP / CLI 客户端不等于 daemon 已退出 |
| 防护配置 | 可指定 config、domain allowlist、action policy、内容边界、输出限制 | 由 main 固定，不能让页面 / 模型放宽；标记不是授权。`--json` 输出不经过普通文本的 max-output 截断，main 仍须做字节上限 |

依据：[MCP schema / 调用实现](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/mcp.rs#L340)、[当前页 read](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/native/actions.rs#L5735)、[snapshot](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/native/snapshot.rs#L182)、[截图](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/native/screenshot.rs#L97)、[Windows 生命周期](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/native/cdp/windows_process.rs#L1)、[JSON 输出](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/output.rs#L507)。

## 4. LCA 要补哪些接口

下列是待设计 / 待实现的契约，不是现有 SDK。建议只实现本能力所需版本，由 LCA 维护人认领；共享类型按项目约定单独提交接口，再接消费方。

| 契约 | 输入 / 输出与范围 | 现有依据、必须补的部分与验收 |
| --- | --- | --- |
| I1 外部网页对象与任务授权 | main 创建不透明 `browserHandle`；内部绑定 user / character / dataRoot / project、runtime / root / member、authorization / activation / policy revision、epoch、允许 origin / 操作；模型仅拿 handle | 当前 MCP 配置指纹和项目路径信任不能表达这些对象。每次调用和返回都核对 epoch；拒绝跨项目、其他成员、旧回合和模型伪造字段 |
| I2 带身份及单次取消的工具调用 | bridge → host → main 传经过验证的 origin、调用 ID 与授权上下文；每次调用有独立 AbortSignal；取消按 ID 到达 main | [host.ts](../../src/main/dsh/host.ts) 已验证 message.origin，但 onCall 只转 name / args / rootSessionId / callId；[ToolContext](../../src/main/harness/tools.ts) 没有成员身份；bridge 的工具 abort 目前只拒绝子端 Promise。需要贯通身份和 call-cancel，不能用 root 授权自动覆盖成员。首个验证可明确只允许主角色 |
| I3 main 浏览器适配与收尾 | 有限 open / observe / read / capture / close；main 固定 EXE、config、env、session / namespace、路径与 deadline；输出受校验的观察结果和操作状态 | 新建 main 内部 browser service；复用 DSH 的执行接入，进程监督由适配层负责。需将已退出客户端、活动 daemon、资源已清理分开核实；不可向模型开放任意 args / shell / CDP URL |
| I4 文本来源与模型投影 | `BrowserObservation` 含 observationId、handle / epoch、页面身份、capturedAt、URL / origin、范围 / 截断 / frame 覆盖、正文或 refs、可选 imageHandle；原文只走获授权模型出口 | [execution.ts](../../src/main/dsh/execution.ts) 的 sourceOf 当前不识别 browser.*。应明确映射为已有 web 来源或新增受审描述，不伪装成邮件 / MCP。日志和 renderer 仅见安全回执；复用 [provenance](../../dsh/lca-bridge/provenance.js) 的退役机制并补图片、摘要、委派与重启证据 |
| I5 有来源的图像传递 | main 解码 / 限尺寸 / 有界压缩；opaque imageHandle 绑定观察与 lease；经 IPC 进入 DSH tool result 的 image block；同一次结果携带范围与来源 | 当前 [MCP](../../src/main/mcp/connection.ts) 普通结果仅 text，专用 image() 固定 screenshot / PNG；[host](../../src/main/dsh/host.ts) 回结果为 value / source，[bridge](../../dsh/lca-bridge/index.js) 的 LCA tool renderer 只输出 text。需新增受限图像结果与渲染 / 序列化，并验证其日志存储和恢复。不是把 base64 放进 JSON 字符串，也不是让模型读任意截图路径 |
| I6 内容路由与观察额度 | 获取数据权限、发送给模型权限、所选 route 的 image 能力、额度、字节 / 图片数量分别检查；返回固定失败类别和安全状态 | 复用 [model capabilities](../../src/main/config/model-capabilities.ts)、[routes](../../src/main/dsh/routes.ts) 与逐步准入；图像字节不等于 token，需确认 DSH 估算并预留图像开销。[privacy/filter.ts](../../src/main/privacy/filter.ts) 仅校园字段，不能当网页或图片脱敏器 |
| I7 有限安全投影 | 书页显示目标 origin / 范围、本次模型接收方、运行 / 等待 / 清理待核对状态、停止；按需提供受授权的本次截图预览 | 复用问题 / 活动 / 交付面；新增数据类型与有限命令。不新增任意网页嵌入、Node 通道、通用 RPC 或替代主工作台 |

I1、I2、I4 是文本也必须有的缺口；I5 和 I6 的图像部分是文本 + 截图版本的增量。现有 `work-frame` 字段、[Minecraft 图像校验](../../src/main/minecraft/screenshot.ts)和[缩图](../../src/main/minecraft/pixels.ts)只能参考边界与解码方法，不能沿用游戏世界身份、800×600 等假设。近期已经实现的模型图片能力声明解决“路由可不可以收图”，尚未解决“浏览器图片如何有来源地送到该路由”。

页面身份方案：导航结果的 targetId、受控 tab 清单、URL / origin 与 main 自有 session 绑定共同核对；不把 session 名称当 document version。刷新、SPA 更新和动态图表可能在两次读取间变化。首阶段明确为**先后观察**，附顺序与范围；检测到目标更换或矛盾则重取，不能宣称文本和图像来自同一瞬间。精确到 document / loader 的一致性若无法从固定接口核实，属于验证停损项；需要小补丁时重新标为 M2 并重估。

### 4.1 推荐连接方式与替代

首选固定原生 EXE + main CLI 适配：只传参数数组，不拼 shell；main 选择私有技术 cwd、显式 `--config`，白名单 env、独占 `AGENT_BROWSER_SOCKET_DIR` / namespace / session，禁止读取项目或用户的自动配置。关闭 restore、外部 plugins / extensions / provider / WebMCP、自动连接与用户 profile，固定 Chrome 和允许的动作 / 域名。模型工具不暴露这些开关。CLI 自身没有模型步骤循环，仍由 DSH 决定下一步。

选 CLI 是本次生命周期与有界输出需求下的工程建议，不是 MCP 协议不兼容。LCA 已有单一 MCP 连接、白名单、文本隐私、来源标记、Clock deadline，可用来验证上游文本连通；但通用工具仍带可选 session / restore / extraArgs，结果还重复携带 stdout / structuredContent。若以 MCP 正式接入，同样需要封闭参数适配、单一连接所有者、图像契约和独立 daemon 收尾；不能从普通 MCP 入口再暴露一份未经适配的工具。

尤其是 [上游 MCP](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/mcp.rs#L511)串行处理 stdin，通知不回复且没有取消处理；子 CLI timeout 默认 120 秒，仅 kill 该 child。LCA 普通 MCP deadline 为 30 秒，超时不证明后台停止。MCP 的 screenshot 还返回最多 10 MiB 的 PNG / JPEG image，而 LCA 现有普通 text schema、256k 传输窗口和 Minecraft 专用 schema 均不是该通用协议。给图片工具改名或提高 buffer 都不能补完这条链。

[配置优先级](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/flags.rs#L368)、[独立 daemon 与 socket 目录](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/connection.rs#L99)、[安全限制](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/docs/content/docs/security.mdx)是上述选择的依据。上游 domain allowlist 与 pre-existing CDP / profile / restore 等模式不兼容，因此首阶段选 fresh context；不能在接管模式失效时悄悄去掉网络限制。域名限制也不等于 OS 防火墙或已登录账号授权。

## 5. 文本和截图如何配合

| 当前任务 | 首次观察 | 何时补充 | 成本和误判控制 |
| --- | --- | --- | --- |
| 找控件 / 确认页面结构 | 限深、限区域的 compact snapshot，interactive 按需求开 | 缺说明补局部文本；图标无标签或位置有意义时补标注截图 | 不固定每步完整 DOM；不把没返回的元素当不存在 |
| 读文章 | 当前页普通 read 或标题 outline，再取相关段 | 公式、排版决定含义或正文由图像承载时取区域图 | 禁止把 read URL 的 HTTP / Markdown fallback 当成当前渲染页证据 |
| 读表格 | 保留表头、行列关联的结构 / 局部文本；必要时 interactive=false | 合并单元格、颜色或布局影响解释时取表格区域图 | 截断必须保留边界；不能为了最短输出丢失对应关系 |
| 图表 / canvas / 无标签控件 | 先读标题、图例及可访问描述 | 缺视觉信息时取目标区域或视口；只需定位才加标注 | 图像内文字仍是第三方内容；缩小后读不清应重新裁切，不猜数值 |
| iframe / 动态页面 | 声明 frame / origin 覆盖与缺失，读取相关区域 | 允许范围内再补目标 frame 的文本或图 | 不声称 read 已遍历全部 frame；未授权 origin 不因在 iframe 中就自动放行 |

建议的工具表面只有少量按用途区分的动作：`browser_open`、`browser_observe`、`browser_read`、`browser_capture`；main 负责 scope 和 close，模型只选择任务内的内容范围。capture 一次返回文字元数据 + image block；标注对应本次 observation 的 refs。普通截图优先保持可读，避免把全页长图机械缩到游戏帧大小。

首版先不用 snapshot delta，避免把不同授权的树、refs 和补丁拼起来。ifChanged 仅在同一 lease / target / 范围 / 尺寸下复用基线；若上次图已退役或未成功送给当前模型，本次“未变”不能假装模型看到了图，需重取。截图未变也不证明导航或后续动作成功。

首阶段原文 / 图像分析只在当前已获授权的主模型路由下使用。独立隐私开启时，现有校园抽取 schema 不足以支持网页分析：明确返回该范围不可用，不要求全局关闭隐私，也不自动回退。若以后确需私有登录页，另设计保留必要结构和 refs 的网页隐私投影；视觉隐私需要获授权且支持图片的独立路径，不能用简单字符串脱敏替代。主模型只有 text 能力时继续可支持的文本部分，视觉部分明确未完成；不隐藏调用其他 vision provider。

| 数据 | 谁可接触 / 发给谁 | 留存与失效 |
| --- | --- | --- |
| URL、页面文本、控件名 | 任务授权后由 main 获取，按内容路由送当前 DSH 模型；公开页面也按第三方来源处理 | 原文不进普通日志 / 通用快照；模型投影下一回合退役。敏感 query / fragment 不进安全标签 |
| 原始截图与标注 | 后端写 main 指定的临时目录，main 校验后给本次模型；可另授权本次用户预览 | 路径不由模型指定；有界解码 / 重编码；任务结束清临时文件。DSH 原始事件可能持久化图像块，必须核实存放位置、退出模型投影及恢复策略，不能承诺全链只在内存 |
| 派生文字 / 摘要 | 沿用来源 lease，不因模型复述变可信 | 不补入自动经历记忆；按原有规则保留用户原话、事实回执和历史，不删除 append-only 日志 |
| runtime / operation 元数据 | main 保存最少 operation、所有者和清理状态，renderer 仅安全投影 | 不保存可续用授权、cookie 或密码；重启仅核对资源，迟到结果不重新绑定给新任务 |

## 6. 哪些地方碰核心 userflow

| 范围 | 等级与决定 |
| --- | --- |
| 明确任务内、专用 fresh 浏览器的文字和截图 | F2：补 I1–I7，但没有改变谁发起任务、选模型、批准、停止或交付；可保持现有主流程 |
| 使用用户登录账号 / 日常标签页 | 至少 F2；一旦授予持续、跨任务或跨成员的软件访问权，涉及 U3 / U5 / U7，需单独 F3 产品决定。不能由 profile / auto-connect 默认值决定 |
| 已授权任务中的点击、填写与提交 | 动作本身不必一概判 F3；在明确对象和逐次决定下可做 F2 扩展。首阶段排除；后续需 work 模型交接、业务动作批准、结果核对和部分执行语义 |
| 插件自带 always-allow、后台接管、自动恢复、另起主 agent / chat / dashboard | F3，触及 U1–U5 / U7 / U8；本路线不采纳 |

落实 U1 / U2：不迁入上游 agent 指导中的整套主流程、chat、嵌套模型或后台 runner；驱动技术队列和 I/O timeout 可保留。落实 U3：main 的对象许可与现有书页批准是权威，上游 confirmation 不成为第二套批准窗口。落实 U4：业务启动、有效期和熄灯走 Clock / Scheduler，headless 不抢焦点。落实 U5 / U6：读取与外发分开，来源跟随文本和图像，不直接变记忆。落实 U7：先撤权后收尾、未知不重试，恢复不自动跑。落实 U8：有限状态仍在书页。

后续操作能力特别要补 [policy.js](../../dsh/lca-bridge/policy.js) 的工具动作分类：当前 handoffOf 和危险命令规则不认识新的浏览器业务动作。按钮点击不能可靠区分“展开详情”与“支付 / 删除 / 发送”；不能靠危险按钮词表宣称安全，也不能把读过页面后的逐次批准改成一次长期会话批准。所需事实来自目标系统回执 / 页面重新核实，不来自模型说“已提交”。

## 7. G1–G5 与 D1–D10 改造账本

| 门槛 | 当前判断 |
| --- | --- |
| G1 职责 / 流程 | 第一阶段方案成立，最高 F2；登录态和输入控制未纳入 |
| G2 可控执行 | 源码路径可定位；CLI / daemon 分离、迟到回调和页面身份仍需有界验证，未通过前不能宣称停止有效 |
| G3 宿主可用 | MCP 文本、来源、Clock、模型能力等可复用；I1–I7 尚未完整存在，截图与 member-call 特别不能按“已有字段”判通过 |
| G4 许可路径 | 主代码使用 / 适配路线明确；随包 EXE、Chrome、Rust / 内嵌资源义务与 hash 是发布门槛 |
| G5 可证明 / 维护 | 运行验收计划完整；E1–E6 未测、维护人待认领。因此先验证，不是已验证目录条目 |

| 项 | 保留 / 关闭 / 替换 / 重写与目标验收 |
| --- | --- |
| D1 包与依赖 | 保留固定 EXE 与所需 Chrome，main 显式绑定版本 / hash；不运行 npx latest、自升级或 postinstall。安装脚本会下载 Release 二进制，实际制品须另审 |
| D2 执行与授权 | 重写有限工具门面，main 固定参数；session / namespace / restore / CA / arbitrary path / extraArgs 不进模型 schema；每次 I1 / I2 重新核对 |
| D3 模型与资源 | 浏览器观察本身不引入模型 provider；使用 LCA 当前 DSH 路由。补图像预算与 IO / 文本 / 图片数量上限，超额不发模型请求 |
| D4 来源与上下文 | 替换原始结果到 I4 / I5；明确 web 来源、当前授权与观察范围；下一轮 / 压缩 / fork / 委派 / 重启图片和派生内容一并退役 |
| D5 数据与作用域 | 配置关闭用户 profile、CDP 自动发现、credentials / storage、restore 和原插件系统；专用数据目录和 main 指定截图路径，拒绝其他用户 / 项目 / 页面 |
| D6 调度与节奏 | 不适用上游业务调度；保留技术 timeout / daemon idle 作为资源保护，不能当 LCA 熄灯停止机制；main Clock 决定业务有效性 |
| D7 结果与交互 | 保留书页问题、活动、失败和交付；新增有限目标 / 清理状态投影。accepted、截图文件存在、CLI 退出 0 不能代替任务完成 |
| D8 生命周期 | main 实现撤权 → 取消客户端 → close 独占 daemon → 核对 PID / 子树 / 临时文件；close 超时保持 unknown，仅对核实归属资源收尾，不全局 kill Chrome |
| D9 存储与恢复 | 配置关闭业务自动 restore / autosave；保留最小操作账本。存档不带浏览器 profile / 登录态 / 原批准；重启不重新 open，原始 DSH 图像事件存放和清理先核对 |
| D10 许可与供应链 | 保留 Apache 归属和告知；实际二进制、Cargo 锁依赖、Chrome、内嵌 axe-core 等分开审查；不采用品牌图形、dashboard 美术或上游角色素材 |

## 8. 迁入能比从头开发省多少

口径：一名熟悉 LCA 的开发者，Windows 单平台，**相同的任务专用浏览器 + 正文 / refs + 局部截图 + LCA 授权 / 来源 / 停止 / 合成反例**。1 人日是工作量单位。下表是源码复杂度拆分的规划估算，置信度中低，未实装计时；不含账号准备、真实供应商调用、法务沟通、正式安装升级矩阵和长期日用。

| 同范围方案 | 后端准备 | LCA 公共接入 | 本地合成 / 生命周期验证 | 总计与取舍 |
| --- | --- | --- | --- | --- |
| 推荐：M1 Agent Browser | 2–3：固定 CLI 契约、参数 / 输出约束、session / daemon 收尾 | 5–8：I1 / I2、来源 / 隐私边界、图像传递 / 预算、安全状态 | 2–3 | **9–14 人日**；保留成熟的紧凑观察、refs、裁切标注和 Windows 后端；新增 Rust EXE 依赖 |
| 可行替代：M4，使用 Playwright 自建 LCA 工具 | 3–5：页面 / locator、正文 / aria snapshot、截图和 ref 映射封装 | 同一 5–8，不能当作已经完成 | 3–4 | **11–17 人日**；对象由 LCA 直接持有、少一个独立 daemon；需自己整理紧凑输出、refs 生命周期和标注 |
| 较底层替代：M4，直接写 CDP 浏览器后端 | 8–12：CDP / target / frame、结构与 refs、读取 / 截图、进程资源 | 同一 5–8 | 3–5 | **16–25 人日**；控制度高，承担更多底层故障，不作为默认自建路线 |
| 暂不迁入 | 0 | 0 | 0 | 继续 web_fetch / 专用连接和用户附图；无法交付自动渲染页观察，日用需求低时可选 |

LCA 的 `playwright@1.64.1` 当前是开发依赖，不能直接当安装版已有运行依赖；但它证明“自建”可从成熟库起步。官方已经提供 [ariaSnapshot](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot)、[正文读取](https://playwright.dev/docs/api/class-locator#locator-all-inner-texts)和[截图](https://playwright.dev/docs/api/class-page#page-screenshot)，不应把这些全算为从零造底层。

**相对于合理的 Playwright 自建方案，中位规划约省 2–3 人日，约两成，区间明显重叠，尚无确定节省。** 相对于直接写 CDP 的匹配低 / 高情境，约省 7–11 人日；这个较大数字不能代替公平主比较。公共 LCA 工作占 5–8 人日，来源 / 图像 / 授权问题不会因换后端消失，也不能把公共接口将来的复用收益预先算成零成本。

若分阶段，M1 仅文本版约 5–8 人日，补图像链与相关反例再加 4–6，合计仍为 9–14；先只做 MCP 文本连通的探针不算文本版完成。若需求缩为“一页公开文字 + 一张静态截图，无稳定 refs / 页面状态”，Playwright 路线可能持平甚至更省，应重新缩范围估算，不能保留全功能估价来制造复用优势。

持续成本：M1 跟踪 Agent Browser schema / 输出、daemon / Windows 行为和 Chrome 组合；M4 Playwright 跟踪库 / 浏览器和自有 refs / 标注逻辑；底层 CDP 路线自行承担协议和更多进程问题。首次相关升级复核暂预留 0.5–1.5 人日，具体以差异范围为准，不是已测平均维护成本。若必须长期 fork Rust 才能解决身份或停止，M1 的节省可能被吃掉，需要重新比较 M2 与 Playwright。

BrowserSkill 的 6–10 人日是“借用 / 归还用户标签页的纯文本观察”，没有相同的登录对象或图片范围；不能与这里的 9–14 直接排名。浏览器研究优先 Agent Browser，BrowserSkill 继续保留给明确的可见借页需求。

## 9. 许可与实际分发

| 内容 / 动作 | 已知依据与义务 | 状态 |
| --- | --- | --- |
| 源码介绍、调用用户另配后端 | 主代码 [Apache-2.0 LICENSE](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/LICENSE)，版权 Vercel；记录来源，不暗示官方 LCA 集成背书 | 本次只读分析可完成；用户账号、网页访问条款不是代码许可证授予的权限 |
| 复制组件 / 修改 fork | 按 [Apache 第 4 节](https://www.apache.org/licenses/LICENSE-2.0.txt)随附许可、保留适用归属、标记修改，核对实际制品适用 NOTICE；品牌权另行判断 | 当前未复制源码 / 未创建 fork；M1 尽量调用原包，减少 fork 维护面 |
| 随 LCA 分发 EXE | 核对实际 Release 来源 / hash / 构建对应，Cargo 锁依赖和内嵌资源，随包告知及适用源码提供义务 | 未清关；不能只凭 Cargo 的 Apache 声明签发整包结论 |
| 内嵌 axe-core | 仓库带 [MPL-2.0 许可](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/native/a11y/LICENSE-axe-core.txt)和第三方告知；第一阶段不开放 a11y 不代表实际二进制没有它 | 分发时需核对包含内容、MPL 相关义务及告知，不从功能白名单推定可以省略 |
| Chrome / 浏览器 | 另有浏览器二进制许可、更新与分发条件 | 首次验证使用后续获授权的专用测试浏览器；本轮未下载。是否随安装包带浏览器另定 |
| 安装 / 更新 | npm postinstall 会下载对应 Release 原生二进制，CLI 还有 install / upgrade | 不随普通启用自动执行；正式分发前固定制品并审脚本，不使用浮动 latest |

未采用上游 dashboard、文案包和视觉素材。正式采纳时把实际采用内容加入 THIRD_PARTY_NOTICES；本次没有把研究候选写成已采用依赖。

## 10. 验收计划、停损与维护

先固定未来验证范围，**本轮以下均未执行**：Windows 一个专用 fresh profile、主角色单任务；5 类自建页面各 2 个任务（文章、数据表、动态表单仅观察、iframe、canvas），10 个任务完整保留失败。页面变化 / 弹窗 / 注入 / 超限 / 取消等反例使用同一 fixture 集合；不读取日常浏览器。纯后端阶段不调用模型。

候选初始界限：每任务最多 10 次业务浏览器调用、120 秒活动预算，每次文字最多 12k 字符且 stdout / stderr 另设 256 KiB 硬上限；最多 2 张模型图片，原图至多 6 MiB / 4096×2304，解码后按用途裁切，模型图至多 1280×960 / 512 KiB。每命令 deadline ≤20 秒、清理另给 ≤5 秒后转待核对，不无限等。均为实验参数，后续按可读性和实际图像计费校准；不能把这些数当已实现的产品限制。

| 维度 | 必须核实的证据 | 当前状态 |
| --- | --- | --- |
| E0 | 固定源码、LCA hash、V / G / D、许可范围、等范围估算 | 本文所列完成，非全仓审计 |
| E1 包装 / 准入 | 固定 EXE 与 Chrome 版本 / hash，无系统 PATH / Node 假设；有限工具 schema 不含 scope / path / extraArgs；启用不启动业务 | 未测 |
| E2 激活 | 独占 namespace / socket / config / session；排除用户配置、profile、restore、provider / plugins；连接 / 缺依赖反馈与单一所有者 | 未测 |
| E3 合成全链 | 书页发起 → 来源 text → 同回合 image block → 模型解释 → 结果；本地合成模型捕获实际出站数据，确认图片不是字符串，text-only / 隐私失败 / 额度不足未外发 | 未测；实现后才能安排，不以现有 read_image 的旧通过记录替代 |
| E4 功能与成本 | 5 类页面正确性 / 缺失说明；文章和表格尽量文本完成，canvas 等需要视觉时实际用图；真实页面 / 模型另行授权 | 未测；总文本 / 图像成本和成功率未知 |
| E5 生命周期 / 隔离 | 预取消、命令中断、daemon 未退、close 丢回执、停用、熄灯、换项目、成员停用、旧 epoch、PID 复用、重启和恢复；只清自己资源、无自动重试 / 重新导航 | 未测 |
| E6 发布 | 安装态依赖定位、实际打包许可、Chrome 组合、升级 / 回退、跨版本回归与用户明确的真实软件验收 | 未测 |

观察成本对照需固定相同任务、模型、权限、截图预算和成功判据，比较工具定义、完整输入输出、追加观察、图片计费、延迟和任务成功；记录首次短输出但多次补读的情况。先比较 Agent Browser 与最小 Playwright 适配；用户需要借页时再将 BrowserSkill 按相同对象语义加入。没有基准实测，不给“更省 token”百分比。

建议实现前先安排最多 2 人日的技术验证窗口：只回答“页面身份 / 图像关联是否足够、能否核实关闭独占 daemon / Chrome、DSH 带来源图像是否可投影并退役”三件事，不扩展为通用浏览器平台。它计入上表工作量，不额外虚增一轮；本次授权不包含执行该验证。

停损：目标更换会串页、关闭后资源无法归属核对、原文 / 图片可绕过来源或隐私、受限模式必须长期 fork 才能维持，任一项未解决即暂停该路线；比较 Playwright，或缩回文本。不能通过加大权限、关掉守卫、暴露 eval 或自动接管浏览器来满足测试。普通网页功能覆盖不足时记录不支持范围，不为覆盖率自动放行全部 origin。

维护触发：上游版本、CLI 输出 / refs / screenshot / config / daemon 行为，Chrome、LCA tool IPC / provenance / model route 或隐私 schema 变化均复核受影响证据。停用立即撤权，清理完成后方可移除拥有的 runtime；用户页面产物与历史不删除。回退不恢复旧授权，未知外部动作先核对。无人维护时停止推荐并保留安全停用路径。

候选目录文案：“任务内网页阅读与按需截图，使用 Agent Browser 后端；LCA 适配方案已评审，尚未安装和运行验证。第一阶段限专用浏览器，不含日常账号接管、表单提交或通用电脑控制。”统计为**一个待验证的 M1 能力候选**，不能计作一个原样兼容 DSH 插件。

## 11. 这次对评审规格的反馈

v0.1 能产生可执行的范围和路线，但应把两项检查固定下来：其一，工具名白名单之外还要审参数能否切换 session、namespace、restore 或路径；其二，图像接口要同时证明实际传递、模型可用、来源退役和持久化行为，不能只检查一个 imageRefs 字段。成本栏必须加入成熟库自建方案；本例由“复用能省很多”收窄为“相比 Playwright 预期省约 2–3 人日，须先验证”。本轮保留规格版本，不把这些设计建议写成已实现的公共 API。

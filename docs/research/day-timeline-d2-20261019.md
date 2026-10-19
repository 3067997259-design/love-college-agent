# D2 一条时间线与安全：实施清单（待审）

2026-10-19，demo 分支 `codex/day-timeline-demo`。D1 已完成（任务对象 + 任务卡 + 剧本）。本文是 D2 的施工清单，先给维护者看，确认后再动手；文中标 **待确认** 的地方不在未确认时擅自改。

## 0. 目标与边界

**做**：去掉心流区间过滤与模式分流（聊天、工作进入同一条时间线/同一份投影）；全天固定工具列表，调用时按任务授权与降级状态判定；标记降级回合；书桌工具输出不进记忆；邮件/附件原文默认不再附进主对话，只有用户显式要求时进入当轮并降级。

**不做**（后续阶段）：D3 接收/唤醒/注意力调度；D4 交班检查点；M2 邮件只经插件；真实项目工作区后端；删除或重写旧 `flow/*` 记录（只停止新用途，历史保留）。

**不变**：主进程拥有事实与权限；日志只追加；逐次审批；旧授权不复活；隐私隔离模型路径保留。

## 1. 现状基线（读码结论）

- 上下文过滤：[context.ts](../../src/main/heart-flow/context.ts) 的 `normalContextAllowedSeqs` 把 flow 区间从普通上下文排除；[controller.ts](../../src/main/bridge/controller.ts) 在心流活跃时用 `heartFlow.messages()` 顶替聊天消息；[service.ts](../../src/main/heart-flow/service.ts) 的心流上下文另行拼装。
- 工具分流：[index.ts](../../src/main/index.ts) 的 `getTools` 按 `heartFlow.active()` 返回两套列表；`backgroundQuiet` 也含 flow。
- 授权：书桌写入门禁仍是 `flow.mode execute` + 逐次审批；D1 的 `authorizedActiveTask()` 已就绪但未接入。
- 记忆：[seen.ts](../../src/main/memory/seen.ts) 只排除 `isSourceTool`（mail/document/student-hub/mcp）；**desk 工具未排除**，目前靠心流 `eligibleIndexes: []` 兜底，去掉分区后必须补。
- 降级：代码里没有降级概念；`privateContext` 每轮自动附上邮件/附件原文（最近 4 封、每封 ≤24k 字）；候选卡的"看原文"是 `readEvidence` 用户只读预览，**不进模型上下文**。

## 2. 事实与接口变更（先提交"接口："）

| 变更 | 内容 |
| --- | --- |
| journal 新增 `turn/degraded` | `{ turnId, sources: ['mail','document','web','mcp','plugin'], reason: 'user-reveal' \| 'third-party-result' }`；只记录本轮为什么降级，不存原文 |
| journal 新增 `context/reveal` | `{ id, source: 'mail' \| 'document', ref, requestId, commandHash }`；用户显式"把原文放进这一轮"的授权事实，只对紧接着的一轮有效 |
| shared 视图 | `AppSnapshot.degraded?: { active: boolean; sources: [...]; sinceTurnId: string }`；候选/资料卡显示"原文来自第三方、本轮降级" |
| 新命令 | `context.reveal { source, ref }`（book-only、用户点按）；降级期间 `task.approve` 一律拒绝（不能新建/扩大授权） |
| 授权查询 | 任务回合 desk 写/删/命令/运行只认 `authorizedActiveTask()` + 逐次审批；未批准任务返回可解释的 `permission-denied` |

**待确认**：D-3（"跟随主模型"改为"读取请求也用主模型、原文默认不进主对话"）是否按建议执行；这是 D2 第 5 项的前提。

## 3. 施工步骤

### Step 1 一条时间线（低风险，先做）

- 删除 `normalContextAllowedSeqs` 的区间过滤用途：普通 prepare 不再排除 flow 区间；`heartFlow.prepareContext` 的新回合不再使用冻结 prefix（旧 `flow/open` 前缀只用于历史 resume/查看）。
- 聊天投影不再按 flow 区间隐藏；`heartFlow.messages()` 只服务旧数据查看。
- flow 面板从对话流移除，设置里的"进入心流"入口 **待确认** 是隐藏还是保留只读历史。
- 验收：进入/退出工作前后，聊天、工作消息、证据在同一 `messages/context` 投影中；不再出现"回聊像不记得"。

### Step 2 全天固定工具列表 + 调用时判定

- `getTools` 返回固定全集（clock、plan、user.ask、desk*、task.*、memory、campus、mcp…），不再按 flow 状态切换；`contextVersion` 工具名不变。
- desk 写/删/命令/run 调用时判定：`authorizedActiveTask()` 命中且调用属于该任务回合才放行；未批准/版本不匹配 → `permission-denied`；desk 读允许。
- 命令与 JavaScript 运行保持逐次批准；产生授权的操作（`task.approve`）在降级轮拒绝。
- 验收：请求捕获显示任务前、中、后工具列表完全相同；未授权写入不产生 desk/change。

### Step 3 降级回合标记与门禁

- 判定：请求里出现第三方原文（用户 reveal 的邮件/附件原文；尚未退役的 web/MCP/来源插件工具结果）即本轮降级，写一条 `turn/degraded`。
- 展示：对话流任务卡/旁白显示"本轮含第三方原文，写文件、执行、外发、付费需逐次批准"；快照带 `degraded`。
- 门禁：降级轮内 `task.approve` 拒绝；写/命令/外发/付费逐次批准且写明来源；不扩大已有授权。
- **待确认**：降级持续期按"本轮 + 未退役第三方结果留在上下文期间"实现；"直到下一次检查点替换为回执"归 D4，先在文档标注为已知空隙。

### Step 4 书桌工具输出不进记忆

- `seenFragments(memoryOnly)` 增加 desk 工具模板（`desk.`）与 assistant 复述结果的排除；新增单测断言工作输入不产生记忆片段。
- 用户在工作中的明确决定仍可通过既有允许片段进入（与 D-4 一致，暂不做开关）。

### Step 5 原文默认不附 + 显式查看

- 从 `privateContext` 删除自动附带的 `campus.mainContext` / `documents.mainContext`；结构化结果（候选、字段、任务事实）照旧。
- 候选/资料卡新增"把原文放进这一轮"按钮 → `context.reveal` → 只附紧接着的一轮，附完即标记降级；UI 显示"这一轮会看到原文"和降级提示，之后不再自动重附。
- privacy 独立路由不变：原文只给隐私模型；follow-main 时才可进入主对话且降级。
- 验收：未 reveal 的请求不含第三方原文；reveal 请求含且带 `turn/degraded`；下一轮不再含。

### Step 6 测试、剧本与旧场景改造

- 单测：时间线不过滤、工具列表恒定、未授权写成拒、降级轮拒绝授权、desk 输出不进记忆、reveal 只生效一轮、重启后降级/授权不复活。
- 新剧本 `pnpm test:timeline-safety`（开发者剧本模型，无真实调用）：
  - S-A 同一任务前/中/后三次请求工具列表一致；
  - S-B 未批准写 → 拒绝；批准后写 → 允许；
  - S-C 合成 Student Hub 注入材料：默认请求只见结构化结果；剧本模型尝试写入被逐次批准拦住；降级轮 `task.approve` 被拒；
  - S-D reveal 原文 → 本轮含原文 + 降级事实；下一轮不含。
- 旧场景改造：`smoke-heart-flow`、`smoke-flow-sleep`、`smoke-flow-drafts`、`smoke-flow-rewind`、`smoke-desk-command`、`smoke-computer`、`smoke-web-fetch`、`probe-heart-flow` 依赖心流按钮/模式，D2 需同步改成任务授权路径或保留只读兼容；`smoke-task-object` 去掉"心流 execute 计划批准"一步。
- 连续性探针（33 项）记录的是"分离现状"，D2 后其中多项会按设计反转：新建 `probe-timeline-safety` 作为新验收，旧探针保留为历史证据并在文档标注"D2 后不再代表现状"。
- 证据存本机 `test-results/d2-*/`，摘要回写执行计划。

## 4. 主要文件

- 上下文/投影：[context.ts](../../src/main/heart-flow/context.ts)、[heart-flow/service.ts](../../src/main/heart-flow/service.ts)、[memory/service.ts](../../src/main/memory/service.ts)、[index.ts](../../src/main/index.ts)、[controller.ts](../../src/main/bridge/controller.ts)
- 安全门禁：[task/service.ts](../../src/main/task/service.ts)、[harness/loop.ts](../../src/main/harness/loop.ts)、[desk-command](../../src/main/desk-command/)、[heart-flow/runner.ts](../../src/main/heart-flow/runner.ts)
- 记忆来源：[seen.ts](../../src/main/memory/seen.ts)、[campus/context.ts](../../src/main/campus/context.ts)
- 事实/视图：[journal/schema.ts](../../src/main/journal/schema.ts)、[shared/state.ts](../../src/shared/state.ts)、[shared/commands.ts](../../src/shared/commands.ts)
- UI：[RightPage.tsx](../../src/renderer/src/book/RightPage.tsx)、[cards.tsx](../../src/renderer/src/book/cards.tsx)、[FlowPanel.tsx](../../src/renderer/src/book/flow/FlowPanel.tsx)

## 5. 完成依据与风险

- 完成依据：Q4 剧本通过；请求捕获显示工具列表全天不变、未降级请求不含第三方原文；typecheck / lint / test；改造后的旧场景脚本通过；证据落 `test-results/d2-*/`。
- 风险：上下文变长与成本上升（D0 基线对比留 R1）；隐藏心流入口影响 8+ 场景脚本与日常使用习惯；降级"持续到检查点"未完全实现（D4 收口）；follow-main 语义改动需要 D-3 确认。

## 6. 请确认

1. D-3 按建议执行：follow-main 只是"读取请求用主模型"，原文默认不进主对话？
2. D2 是否移除心流面板入口（推荐：隐藏入口，保留旧记录只读查看），还是先只隐藏对话流里的面板？
3. 降级持续期先按"本轮 + 未退役第三方结果在上下文期间"实现，检查点收口留 D4，可以吗？

## 7. 实施进度（2026-10-19，维护者已确认全部按建议）

| 项 | 状态 |
| --- | --- |
| D-3 语义 | 已按建议：原文默认不附主对话，只有用户点"把原文放进这一轮"才 attach 一次 |
| 心流入口 | 已隐藏：对话流不再渲染 FlowPanel，设置里的进入/模式/运行按钮移除，只保留旧记录只读查阅 |
| 降级持续期 | 已按建议：本轮 + 上下文里未退役的第三方结果；检查点收口留 D4 |

已完成：

- 日志与视图：`turn/degraded`、`context/reveal`；`desk/change` 支持 `taskId`（flow/task 二选一）；`AppSnapshot.degraded`。
- 一条时间线：普通 prepare 不再按 flow 区间过滤（`includeContextEntries` 恒为全量）；聊天投影不再被心流消息顶替。
- 全天固定工具列表：普通回合固定包含任务书桌工具（`desk_read/write/edit/find/grep`，经任务授权）与 `task_propose`，不再按 `heartFlow.active()` 切换；`backgroundQuiet` 去掉心流项。
- 任务书桌门禁：读允许；写/改/删要求 `authorizedActiveTask()` 且非降级轮；写前落 `desk/change{taskId,pending}`，成功落 `desk/settled`。
- 降级门禁：本轮出现第三方原文（reveal）或未退役 mail/document/web/MCP/来源插件工具结果时写 `turn/degraded`；降级轮拒绝 `task.approve`，书桌写入返回 `DEGRADED_SOURCE_REQUIRES_APPROVAL`。
- 记忆：`seenFragments(memoryOnly)` 排除 desk/工作工具结果及该回合她的复述。
- 单测：`tests/unit/d2-safety.test.ts`（未授权写成拒、降级轮拒绝写入与授权、重启/投影降级清空、工作输出不进记忆）。
- 回归：`smoke-task-object` 仍通过（旧心流命令路径保留给历史场景，产品 UI 已不可进入）。

待完成（D2 收尾）：

- Q4 剧本 `pnpm test:timeline-safety`：固定工具列表请求捕获、未授权写入被拦、合成注入材料下默认请求不含原文、reveal 只生效一轮。
- 旧心流场景脚本（`smoke-heart-flow` 等 8+ 个）改为任务授权路径或标记为历史脚本；连续性 33 项探针按设计反转，另立 `probe-timeline-safety`。
- 收尾证据 `test-results/d2-*/` 与执行计划 §D2 结果摘要。

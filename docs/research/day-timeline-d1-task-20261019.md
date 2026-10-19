# D1 任务对象：契约与实施清单

2026-10-19，demo 分支 `codex/day-timeline-demo`。D0 基线已在含 M1 的 main 上完成。本文把[执行计划](day-timeline-demo-20261019.md) §2.1 的"任务"落实为日志、投影、交互与执行切片，并记录 D1-A 已落地的接口。设计仍是建议，以剧本与单测结果为准。

## 1. 范围

做：任务日志记录（开启、计划版本、授权、手上任务、检查点、结束）、投影与共享视图、模型提议工具、任务卡进入对话流、批准后按计划推进与结束；单测覆盖投影与重启；剧本场景能从聊天提出、批准、推进并结束一件任务。

不做（后续阶段）：去掉心流区间过滤与全天固定工具列表（D2）；注意力调度与专注续跑（D3）；交班检查点格式与跨天恢复（D4）；真实项目工作区后端（另行推进）。D1 期间现有心流继续承担书桌执行与逐次审批，任务卡先与心流共存；D2 再把执行判定切到任务授权。

## 2. 日志记录（append-only，main 事实）

任务记录与现有 `flow/*` 并存，不改写旧记录。

| 记录 | 字段 | 语义 |
| --- | --- | --- |
| `task/open` | `id, title, goalId?, workspace:'desk', source:'model'\|'user'` | 创建任务。提议只是事实，不是授权。 |
| `task/plan` | `taskId, planVersion, source, steps[{id,text}]` | 带版本计划。新版本不继承旧批准。 |
| `task/approve` | `taskId, planVersion, scope{writes:'desk', commands:'each'}` | 用户批准，绑定具体计划版本与范围。 |
| `task/focus` | `taskId \| null` | 手上任务；D1 同时最多一个。 |
| `task/step` | `taskId, stepId, status` | 计划步骤推进。 |
| `task/checkpoint` | `id, taskId, source:'model'\|'code', summary, evidenceSeqs?` | D1 最小检查点；D4 再扩展为交班。 |
| `task/close` | `taskId, status:'completed'\|'abandoned'\|'failed', summary?` | 终态。 |

约束：字段名必须避开日志 envelope 的 `version` / `seq` / `atMs`；`task/plan.version` 在 D1-A 首版实现中与 envelope 冲突并被覆盖，已改为 `planVersion`，由重启解析测试兜底。

追踪字段（D1-B 加入，可选）：`task/open`、`task/plan`、`task/step` 带 `turnId`，`task/approve`、`task/close` 带 `requestId` / `commandHash`；重放同一用户请求只返回原 ack，不重复写授权。

## 3. 投影与共享视图（D1-A 已实现）

- `SessionProjection.tasks` + `activeTaskId`；`AppSnapshot.tasks?` / `activeTaskId?` 用可选字段保持旧 renderer 与旧快照兼容。
- 状态派生顺序：终态（completed / abandoned / failed）优先，其次 `activeTaskId` 命中的任务为 `active`，有当前版本批准为 `approved`，否则 `proposed`。
- 换计划版本：清空旧批准、步骤状态全部回到 `pending`；批准只对 `planVersion` 相同的最新计划有效。
- 重启 = 纯重放：单测用真实 journal 文件关闭重开，断言投影 JSON 与关闭前完全一致。
- 视图 `TaskCardView`：`id, title, goalId?, workspace, status, plan?, approval?, checkpoints, createdAtMs, updatedAtMs, closedAtMs`。
- 文件：[schema.ts](../../src/main/journal/schema.ts)、[projection.ts](../../src/main/journal/projection.ts)、[state.ts](../../src/shared/state.ts)、[controller.ts](../../src/main/bridge/controller.ts)。

## 4. 交互与授权（D1-B 已实现）

1. **模型提议**：工具 `task_propose`（结构化 `title` + 计划步骤，可选 `goalId`），只追加 `task/open` + `task/plan`（`source:'model'`），不写授权；返回 `taskId`。仅在普通聊天回合提供；已有一个未结束任务时返回固定错误 `task-busy`。
2. **用户批准**：命令 `task.approve {taskId, planVersion}`；同一审批动作追加 `task/approve` + `task/focus`。任务卡显示计划步骤与授权范围（书桌写入、命令逐次批准），不出现"允许一切"。
3. **推进**：工具 `task_step {stepId, status}` 可更新手上任务已批准版本的计划步骤；无手上任务、未批准或步骤不存在分别返回固定错误。任务回合仍走同一 harness 与 chat 模型。授权查询 `authorizedActiveTask()` / `isPlanAuthorized()` 已实现；**desk 写入的实际 gate 在 D2 切到任务授权时接入**，D1 继续由现有心流 execute 与逐次审批守门。
4. **结束**：命令 `task.close {taskId, status, summary?}`；模型只能建议完成，终态由用户决定（与目标状态的"用户标记"一致），已结束任务再关闭返回 `invalid-command`。
5. **卡片进入对话流**：右页消息流内插入任务卡（标题、状态、计划步骤、批准 / 结束按钮、检查点）；不新增全局模式。心流面板在 D1 内保留，D2 收尾。
6. 共享命令契约（`AppCommand` 增加 `task.approve` / `task.close`）已按约定单独提交，标题以"接口："开头。

## 5. 执行链路与证据

- 任务回合复用现有 harness、模型客户端、tool/call、tool/result、desk/change 记录；任务卡只做投影，不新造"完成证明"。
- 授权查询（D1-B）：`activeTaskId` 与 `approval.planVersion` 同时匹配当前计划版本才视为已授权；重启后旧批准不复活，未批准版本不放行。desk 写入的强制 gate 在 D2 接入。
- 检查点引用 `evidenceSeqs`，不把正文或工具原始输出塞进卡片。

## 6. 验收

- 单测：投影 / 重启（`tests/unit/task-projection.test.ts`）；任务服务与命令（`tests/unit/task-service.test.ts`）覆盖提议占用、错误版本拒绝、步骤仅限已批准手上任务、用户关闭、重启后旧批准不复活、重复 `task.approve` 请求不重复写授权。
- 剧本 S0（`pnpm test:task-object`，开发者剧本模型，无真实调用）已通过：聊天提出 → 模型 `task_propose` 生成任务卡 → 用户点按批准 → 心流 execute 下 `desk_write` + `task_step` 推进 → 用户点按结束 → 重启后状态一致。结果见 §9。
- 真实模型（授权后）：同剧本跑一次，记录 token 与缓存，留作 R1 对照；报告只含数字、哈希与枚举。**待 D5。**
- 证据存本机 `test-results/d1-task-object/`，摘要见 §9 并回写[执行计划](day-timeline-demo-20261019.md)。

## 7. 实施切片与提交

| 切片 | 内容 | 状态 |
| --- | --- | --- |
| D1-A | 日志记录、共享视图、投影、快照接入、投影/重启单测 | 已完成（2026-10-19） |
| D1-B | 共享命令契约、任务服务（提议/批准/步骤/关闭/授权查询）、`task_propose` / `task_step` 工具、controller 派发与命令重放、单测 | 已完成（2026-10-19） |
| D1-C | 任务卡 UI（对话流）、剧本脚本与运行证据 | 已完成（2026-10-19） |

提交顺序：先接口（共享命令/视图），再消费方接入；每步跑 typecheck / lint / test。

## 8. 待决定与风险

- D1 是否直接隐藏心流面板入口，还是与任务卡并存到 D2；先并存。
- 任务卡位置：消息流内卡片（拟采用）还是常驻顶部；先做消息流卡片，避免变成另一个面板。
- 旧心流数据不迁移、不改写；合并前再按执行计划 §6 把旧区间投影为历史任务。
- 授权范围目前只有书桌写入 + 命令逐次；真实项目工作区按 [harness 调研](harness-workspaces-20261019.md) 另行推进，不在 D1 混测。

## 9. D1 验收结果（2026-10-19）

剧本 S0：`pnpm test:task-object`（Electron 开发者 profile + 剧本模型；不调用真实模型、不联网）。固定步骤：聊天提出"写完作业二，先给计划" → 模型 `task_propose` 提议 → 用户点任务卡"批准这份计划" → 进入心流并批准 execute（现有安全墙）→ 剧本模型 `desk_write` 写 `answer.js` 并 `task_step` 完成第一步 → 退出心流 → 用户点任务卡"标记完成" → 关闭重开验证重启投影。

| 项目 | 结果 |
| --- | --- |
| 提议 | `proposed`；planVersion 1；3 步均为 pending；任务卡在对话流可见 |
| 批准 | 用户点按后 `active`，`activeTaskId` 命中；授权绑定 planVersion 1，scope 为书桌写入 + 命令逐次批准 |
| 推进 | 心流 execute 下 `desk_write` 命中 `answer.js`，`task_step` 把第 1 步置 done；任务回合 completed |
| 结束 | 用户点按后 `completed`，`activeTaskId` 清空；模型没有关闭任务的工具 |
| 重启 | 卡片仍可见；status `completed`、授权 planVersion 1、步骤 `done/pending/pending` 与关闭前一致 |
| journal | 63 行；`task/open`、`task/plan`、`task/approve`、`task/focus`、`task/step`、`task/close` 各 1；`flow/mode` execute 1；`tool/call` desk_write 1；`desk/change` 1；`flow/open`、`flow/close` 各 1 |
| 审批 | 任务审批 **1 次**；另有现有心流的"批准计划并允许书桌写入" 1 次（D2 去掉心流墙后合并） |

证据在本机 `test-results/d1-task-object/scenario.json`（只含计数、布尔与状态，无正文或密钥）。D1 完成依据（投影/重启单测 + 剧本场景）已满足；下一阶段 D2 去掉心流区间过滤与全天固定工具列表，并把 desk 写入门禁切到任务授权。


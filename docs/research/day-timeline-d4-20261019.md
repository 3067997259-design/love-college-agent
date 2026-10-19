# D4 交班：实施清单与进度

2026-10-19，demo 分支 `codex/day-timeline-demo`。D3 已完成。本文记录 D4 交班的契约与第一批实现；跨天恢复、重新授权与 Q5 剧本待续。

## 1. 目标（执行计划 D4）

专注结束触发交班：模型用结构化工具提交完成项、引用用户消息的决定、未决问题和下一步；代码校验并附上文件、命令和她自己作品的证据；失败时写入只含证据的兜底检查点。检查点成为 B 段，旧第三方工具结果替换为回执，跨天从检查点恢复。

## 2. 记录与视图（第一批已实现）

- 日志 `task/handoff`：`taskId / planVersion / source:'model'|'fallback' / turnId?`，`completed[]`、`decisions[{messageId,text}]`、`unresolved[]`、`next[]`，以及**代码收集**的 `evidence{changes[{path,sha256}], commands[{id,status}], lifeWork[{id,path,sha256}]}`。
- 共享视图 `TaskHandoffView`；`TaskCardView.latestHandoff?`。投影只认最后一条交班记录。
- 校验（[handoff.ts](../../src/main/task/handoff.ts)）：
  - 只对当前已批准的手上任务交班；无授权返回 `no-authorized-task`；
  - 每条决定必须逐字出现在真实 `user/message` 中，否则 `invalid-decision`（模型不能把转述变成授权）；
  - 完成项/未决/下一步全为空返回 `invalid-content`；
  - 证据由代码按 `desk/change{taskId}`（hash 取 after 文本）、`flow/command` 回执、`life/work-state` 已确认产物收集，模型不提供路径或哈希。
- 工具 `task_handoff`（普通回合工具列表）：参数为上述四个文本数组；拒绝时把固定错误码交回模型。

## 3. 触发与 B 段（第一批已实现）

- 番茄 `focus-ended` 事件（现有 pomodoro emit）设置待交班标记；下一次 `pomodoro` 触发的回合在 D 段追加 `handoffRequest`，要求模型调用 `task_handoff`。
- 该回合 `turnSettled` 时若没有有效 `task/handoff`，代码自动写 `source:'fallback'` 的兜底检查点（完成项=已 done 步骤，下一步=未完成步骤，证据照常）。
- 任意后续请求在 system 段之后插入最新 `handoffCheckpoint` 作为 B 段；旧第三方工具结果继续由 `retireSourceContext` 替换为回执。
- 旧授权不延续：B 段只提供上下文，执行仍要求当前计划版本的批准（D2 的任务授权门禁）。

## 4. 验收（第一批）

- 单测 `tests/unit/handoff.test.ts` 4 项：有效交班+证据+B 段投影、转述决定/空交班/无授权被拒、兜底检查点、主进程接线（工具/B 段/兜底焦点事件）源断言。
- `pnpm test` 83 文件全过；typecheck / lint 通过。

## 5. 待做

| 项 | 内容 | 验收 |
| --- | --- | --- |
| 跨天恢复 | 日切后从最新检查点恢复任务卡；`task/resume` 类命令或聊天"接着昨天那个"入口 | 次日可接着任务；不重做已完成步骤 |
| 重新授权 | 跨天/重启后的旧批准不复活，恢复时重新批准计划版本 | 单测：重启后旧 approval 失效 |
| 任务卡展示 | 卡片展示最新交班（完成/决定/未决/下一步/证据条数） | UI 剧本 |
| Q5 剧本 | 专注结束交班含任务与她自己的进展；日切后恢复；旧授权需重新批准 | `test:handoff-flow` 通过，证据 `test-results/d4-*` |
| 命令证据 | 命令审批路径在任务回合尚不可用（旧 flow 命令仅历史脚本）；D4 先收集已有 `flow/command` 回执 | 与 D2 遗留一起在 demo 收口时决定 |

## 6. 已知限制

- 交班触发只覆盖番茄 `focus-ended`；用户主动停止/中断的专注暂不触发交班（可后续用 `focus-interrupted` 事件扩展）。
- 跨天投影目前只读当日日志，恢复入口在第二批实现前不存在。
- 真实模型交班质量与证据引用留在 D5/R1 真实协议。

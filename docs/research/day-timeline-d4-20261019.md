# D4 交班：实施清单与进度

2026-10-19，demo 分支 `codex/day-timeline-demo`。D3 已完成。本文记录 D4 交班的契约、两批实现与 Q5 验收；跨天恢复与重新授权已在第二批落地。

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

## 5. 第二批（已完成 2026-10-19）

- **跨天恢复**：启动时若当日还没有任务，[carry.ts](../../src/main/task/carry.ts) 从历史里取最后一个未关闭、有计划且有交班的旧任务，在当日的 append-only 日志里重新落 `task/open` + `task/plan` + `task/handoff`。任务以 `proposed` 出现，旧 `task/approve` 不复制；模型交班优先于代码兜底。单测 `tests/unit/task-carry.test.ts`。
- **重新授权**：恢复后的任务 `approval` 为空，`activeTaskId` 为空；用户批准后才恢复 active。旧授权不复活由单测覆盖（批准行只在当天新增 1 条）。
- **交班只在焦点结束回合**：`task_handoff` 提交额外校验 `turn/start.trigger === 'pomodoro'`，普通回合或自主续跑回合调用返回 `invalid-turn`，避免工作步骤误交班。
- **任务卡展示**：`ObjectCard` 渲染交班的完成/决定/未决/下一步与证据条数（文件/命令/作品）。
- **开发者预算**：开发者剧本模型不经过资源账本，且 harness 使用放大的合成预算（脚本体零 token），避免长合成时间线被预留额度假性拦截；生产默认值不变。

## 6. Q5 验收结果（2026-10-19）

剧本：`pnpm test:handoff-flow`（Electron 开发者 profile + 剧本模型，无真实调用）。步骤：聊天提议并批准任务 → 普通回合写入 `answer.js`（带 `taskId` 的 desk 证据）→ 开始 8 秒专注（期间自主续跑 4 回合到上限）→ 专注结束交班回合调用 `task_handoff` → 卡片显示检查点 → 时钟前进 26 小时并重启 → 任务以交班检查点恢复为 `proposed`（无批准）→ 重新批准成功。证据：`test-results/d4-handoff/scenario.json`。

| 项目 | 结果 |
| --- | --- |
| 交班来源 | `source: 'model'`；`completed: ['写出 answer.js']`，`next: ['检查']` |
| 代码证据 | `evidence.changes = ['answer.js']`（sha256 由代码计算） |
| 卡片 | 任务卡显示“交班检查点” |
| 跨天恢复 | 次日任务 `proposed`、`approval = null`、`latestHandoff.source = 'model'`、`activeTaskId = null` |
| 重新授权 | 新批准后 `active`；当天新增 `task/approve` 1 条 |
| 旧授权 | 未复制到次日，恢复后未批准前不能执行 |

## 7. 已知限制

- 交班触发只覆盖番茄 `focus-ended`；用户主动停止/中断的专注暂不触发交班（可后续用 `focus-interrupted` 事件扩展）。
- 跨天恢复在启动时执行一次；若一天内跨零点继续运行，等下次重启/会话切换才恢复（与现有日切机制一致）。
- 任务卡展示是只读文本；更细的决定跳转/证据查看留后续打磨。
- 命令证据：任务回合还没有逐次审批命令通道，D4 只收集已有 `flow/command` 回执；与 D2 遗留一起在 demo 收口时决定。
- 真实模型交班质量与证据引用留在 D5/R1 真实协议。


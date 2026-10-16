# 独立草案与当天番茄进度

2026-10-16 23:17。用户补充：她的新草案不能顶掉已经确认的计划，确认后也不能从第一个番茄重新算。

## 接口与 Claude 交接

完整接口 SHA **`e49813c`**（`接口：统一番茄条目、独立草案与今日进度契约`），先合 main `67040f0`。此前条目接口已推送并被消费，因此保留公开历史，在这一补充提交里把 items、proposal、计数与命令的完整契约集中到 `src/shared/`，没有改写旧提交。

`PomodoroView` 新增 `proposal?: PomodoroPlanView` 和主进程提供的 `completedCount`（为兼容旧 fixture，类型字段可省略）。条目保持 `items?: readonly { text: string; count: number; assist: boolean }[]`。新增用户命令 `pomodoro.discard(planId)`。

Claude 已按此接口合入 `12bd11f`：独立草案卡、保留顶部生效计划、“不用了”仅丢草案；本轮集成采用其接线和画面。GPT 另调整自己负责的设置页，以及预览计时锚点和边界计数，不改她的美术与角色文案。

## 代码规则

| 动作 | 结果 |
| --- | --- |
| `pomodoro.plan`／`plan_pomodoros` | 任何阶段可提草案；只替换 proposal，不动 plan、focusIndex、plannedCount、阶段、当前时长、截止点或暂停原因 |
| `pomodoro.confirm(planId)` | 只接受当前 proposal id，再检查总数不少于 focusIndex；更新生效计划和当天总数、清草案，保留当前阶段与已完成数 |
| `pomodoro.discard(planId)` | 只删除匹配草案；过期 id 拒绝，不影响生效计划或计时 |
| `pomodoro.stop`／工具 stop | 只结束生效计划，保留草案；尚未完成的专注不计作完成，已完成进度保留 |
| `get_timer` | 返回生效计划、草案、focusIndex、completedCount、阶段与时长；模型可据此按当天总数重新排 |

plannedCount 与 items 的 count 求和均表示**今天总共几个**，包括已完成和正在进行的那个，不是再加几个。提议和确认都拒绝总数小于 focusIndex；确认前进度可能已经增加，因此不能只在提议时检查。非法输入不追加事实。

focusIndex 在专注中包含当前段，completedCount 排除正在进行或暂停的当前专注；休息／空闲时二者一致。确认不清零。空闲时若新总数恰等于已完成数，该计划直接记 finished；当前阶段仍在跑时，即使新总数等于 focusIndex，也先照常走完当前阶段。新计划的时长配置从下一阶段使用。

确认／提议／丢弃都保留 manual／lights 暂停原因，不会偷偷恢复暂停。确认新 plan id 不视作新专注开始，不会把用户刚展开的书再次收进迷你窗。

## 日志、旧数据与重启

继续追加 `pomodoro/state`，新增 discarded 原因。投影派生完成数；新事实写入一致的完成数。旧日志中 `plan.status=proposed` 仍能解析，但只在读取投影时映射成 proposal；原始日志不改写，不能在公开 plan 中继续出现未确认草案。已丢失的历史进度不凭空补造。

草案随现有日志、SQLite 投影和 `.lca-save` 保存。备份与恢复的运行结果仍以实际文件和重启验证为准，不把内存状态当恢复证明。

## 本轮验证

合并 Claude 的最新界面之后，`pnpm typecheck`、`pnpm lint`、`pnpm test` **31 个文件／135 项**通过。本轮新增 6 个 Vitest 场景，覆盖用户要求并补足边界：

- 做完 1 个后提草案，旧 plan、focusIndex 和阶段不动；确认后已完成 1 个仍在，下次从第 2 个开始。
- 替换／discard 只动草案；旧草案 id 拒绝；只有草案时 stop 拒绝，停止生效计划不丢草案。
- 专注中提议与确认保留当前截止点和段长；新时长只在下一阶段使用。
- 休息中、手动暂停时确认保留剩余量、截止点和暂停原因。
- 总数小于进度时提议／工具拒绝；草案因后续进度变小后，确认再拒绝且不写事实；get_timer 给出完成数。
- 旧 proposed-in-plan 记录重放为草案，源记录保持旧格式。

实际 Electron 的 `test:pomodoro` 新增：做完 1 个后用“不用了”按钮丢草案，旧计划不动；用“就这么排”确认后进度保留；在运行中的专注展开书本，再确认新草案，计时不变也不重新收窗。原有双窗口／强制不透明／合成黑角／重启场景继续通过。

同批 `test:mini`、`test:backup` 和原生 pomodoro 探针通过，验证窗口、完整私人存档、跨 4 点截止点和过期仅结算一次。使用显式 fake 或不存在的供应商文件，没有真实模型调用、IMAP 重试或新安装包构建。

底层提交 `693b783`，集成 main `eb45eb7` 的远端 [CI 通过](https://github.com/3067997259-design/love-college-agent/actions/runs/38922779670)。随后仅清理 Claude 在主进程落地前的 stop 兼容接线，再跑类型、该文件 lint、构建与完整番茄窗口流程，通过；“不用了”现在只发 discard。

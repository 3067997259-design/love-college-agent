# GitHub Issue 自动巡检（第三轮，2026-10-17 03:06–03:30）

本轮 open issue 从 2 条涨到 7 条，其中 #10 是上一轮 #9 修复引入的**回归**（P1）。核实仍由只读队友独立完成，修复按仓库门槛（先复现、再过 typecheck/lint/test、合 main、等 CI success）执行。

同一天稍晚的第四轮（03:36–04:10）另见 [第四轮记录](issue-audit-round4-20261017.md)。

## 判定与处理

| 问题 | 核实判定 | 处理 |
| --- | --- | --- |
| [#10 房间重建把 ASCII 命名的用户备份误判为投影并永久删除](https://github.com/3067997259-design/love-college-agent/issues/10) | **真（P1，上一轮 #9 引入的回归）**：所有权靠名字字符集推断，用户存进投影目录的 `my-backup.zip`／`README.txt` 会被 `rmSync` 删掉 | 修复 `52436f3`（台账化）＋ `218c13e`（台账按 owner 作用域），合并 `13b7358`／`fd64146` |
| [#11 自动照片重试耗尽后仍占候选首位](https://github.com/3067997259-design/love-college-agent/issues/11) | 真：`reconcile` 不比「可尝试」，一个坏事件让当天后续照片永久缺失 | 修复 `f3d2efe`，合并 `6167f53`，已关闭 |
| [#13 首件羽毛笔未触发赠礼照片](https://github.com/3067997259-design/love-college-agent/issues/13) | 真：候选从不认 `quill/given`，与 tech-design §3.16 脱节 | 同 `f3d2efe` 一起修（同一函数），已关闭 |
| [#12 回忆进行中普通插话丢失历史引用](https://github.com/3067997259-design/love-college-agent/issues/12) | 真：`relevantRequest()` 用「最新一条 user/message」推断当前回合 | 修复 `31eb14f`，合并 `39b7939`，已关闭 |
| [#7](https://github.com/3067997259-design/love-college-agent/issues/7) | 上一轮修复已合入并被关闭，但随后被 **reopen**，且没有新的复现说明 | 保留 open；未发现新的反证 |
| [#6](https://github.com/3067997259-design/love-college-agent/issues/6) | 与上一轮一致：代码成立、严重度下修、一次性迁移未实现 | 保留 open |
| [#2](https://github.com/3067997259-design/love-college-agent/issues/2) | 上一轮已复核修复机制在位，无新说明 | 保留 open |

## 修复内容

- **#10（含 #9 的语义修正）**：`room/projection.ts` 不再用文件名推断所有权，改为**台账**：每次重建把实际写过的投影路径记入房间根 `.managed.json`，只有「台账里有」且「当前日志不再需要」的文件才会被删除；台账缺失或不匹配当前 owner 时本轮**不删任何东西**。用户保存进投影目录的文件（无论中英文名）、子目录、符号链接一律保留。
- **#11**：`capture` 的守卫抽成同一条「可尝试」谓词（无成功照片 && `started` 次数 < 3），`reconcile` 先用它过滤候选再比优先级；计数只数 `started`，重试投递不会重复计数。
- **#13**：候选增加 `quill/given` → `{ reason: 'gift', eventId: 'quill:' + row.id }`，沿用既有成功去重与三次上限。
- **#12**：`relevantRequest(turnId)` 先看该回合的 `history/recall-used` 绑定，没有绑定才回退到最新 `user/message`；`prepare` 与 `recall_seen`（`tool.run`）共用同一解析，跨回合复用与预算限制未改。

## 本轮实跑过的证据

- 复现：三位只读核实员分别用 Node 24 类型擦除直接导入仓库真实模块（`room/projection.ts`、`history/photos.ts`、`history/recall.ts`），在 `$env:TEMP` 合成输入下复现了 #10／#11／#13／#12，脚本跑完即删、未写仓库。
- 回归：`tests/unit/room-projection.test.ts` 增至 6 项（含「ASCII 用户文件保留」「只有台账证明过才删」「首次运行不删」「owner 变化不删」）；`history-photos.test.ts` 增至 6 项（三连失败后下一个事件仍能拍、空转不增加调用、羽毛笔升级为 gift、只有 quill 且跨日也能拍）；`history-recall.test.ts` 新增同回合插话后引用与扩读仍可用。
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（43 文件／212 项）通过；`pnpm test:room`（真实 Electron）通过；`6167f53` 的 CI success。
- 房间场景脚本改为验证台账语义：用户文件与书桌文件在 `room.rebuild` 后原样保留。

## 未覆盖边界

- 未跑真实 Electron 双 profile、真实截图链路与 5 秒实时调度；#11 的 4:00 日切跨页行为、#12 的真实 harness drain 时序端到端均未验证。
- 同一回合内出现**新的** `history.recall` 指令是否应替换已绑定请求，属于产品决定，本轮按现状保留（不替换）。
- 老 profile 升级后当天可能为一件「旧礼物」（首件羽毛笔早已在历史页）补拍一张照片，观感未人工验收。
- 上一轮的 #9 修正在本轮被 #10 修正语义：**只有台账证明写过的文件才会被清理**，因此更早版本遗留的孤儿投影不会被自动清掉，这一点符合「宁可留下也不误删」的取舍。

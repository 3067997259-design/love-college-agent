# GitHub Issue 自动巡检（第四轮，2026-10-17 03:36–04:15）

本轮又出现 7 条新 issue（#14–#20），由只读核实员独立复核后按仓库门槛处理。核实用 Node 24 类型擦除直接导入真实模块，在 `$env:TEMP` 合成输入下复现，脚本跑完即删。

## 判定与处理

| 问题 | 核实判定 | 处理 |
| --- | --- | --- |
| [#14 接地 source 在每个记忆分片中重复传输](https://github.com/3067997259-design/love-college-agent/issues/14) | 真（生产代码端到端复现）：10,000 中文字符合法消息 → 5 片，每片重复携带完整 `source`，序列化 181,090 字节／reservation 187,234 > 100,000，首轮即 `budget-exceeded`，fetcher 0 次；长消息还会饿死后续短消息 | **未修**（见下） |
| [#15 邮件接地仅校验 titleQuote](https://github.com/3067997259-design/love-college-agent/issues/15) | 真（真实 `extractMail` 复现）：`privacy.ts` 对 task 只做纯子串判断，「本周不交作业」→ task「交作业」被接受并高亮 | **未修**（见下） |
| [#16 已完成作品冲突后续做排第 4 步、卡在无 worker 的 running](https://github.com/3067997259-design/love-college-agent/issues/16) | 真：attempt 的 step = `completedSteps + 1` 被 journal 拒绝，状态残留 running | 修复 `1719b7d`，合并 `a80b5fc`，已关闭 |
| [#17 外部编辑超过读取上限后启动直接失败](https://github.com/3067997259-design/love-college-agent/issues/17) | 真：64,001 字节检查点让构造抛 `DESK_INVALID`，落到 `index.ts` 的 `app.exit(1)` | 同 `1719b7d` 一起修，已关闭 |
| [#18 跨日重启后日程页隐藏 interrupted 作品](https://github.com/3067997259-design/love-college-agent/issues/18) | 真（显示层，数据未丢）：日程页过滤只留当天／running／paused，恰好滤掉需要用户处理的 interrupted 旧项 | **未修**（见下） |
| [#19 历史页切换后保留上一页选段](https://github.com/3067997259-design/love-college-agent/issues/19) | 真（渲染层状态残留）：选段是组件本地 state，切页不重挂载也不清空 | **未修**（见下） |
| [#20 接地实验标准复跑必然断言失败](https://github.com/3067997259-design/love-college-agent/issues/20) | 真：自检假定所有样例引文都是连续子串，与两条语义探针冲突，两种模式都 exit 1 | 修复 `206b071`，合并 `140a096`，已关闭 |

## 本轮修复

- **#16 + #17（`life/work/service.ts`）**：`tick` 先写 attempt 再置 running，append 失败不留伪 running；`tick`／`resume`／启动对账都先判 `completedSteps >= totalSteps` 并结算为 completed，绝不排第 4 步；启动对账不再把本轮判定为 conflict 的项按「全部步骤已提交」覆盖成 completed；`rebuild()` 的每个材料与检查点 IO 各自收敛错误，超限文件或路径变目录只让该项 conflict，**不再让用户文件的 IO 错误决定进程生死**。
- **#20（`scripts/experiment-deeptech-grounding.mjs`）**：给非子串的语义探针加 `atomic: false`，自检改为「原子引文强制子串 + 非原子引文反向断言确实不是子串」。样例、`kind` 与指标口径未动 —— 两个模式现在 exit 0，留出集 OURS FAR 0/24、FRR 0/20。

## 未修的 4 条与原因

- **#14/#15**：都涉及共享的记忆／邮件链路，改动面较大（#14 要把 `SeenFragment` 拆成本地校验载荷与模型 DTO 两型，并改批次按序列化体积选取；#15 要把 task 的作用域接地锚定到它在 `titleQuote` 内的那次出现）。核实已给出精确落点与反例集，留给对应编码线按自己的节奏做。
- **#18/#19**：都是渲染层问题，而本轮期间界面文件正在被另一条线重构（`ScheduleSheet` 已移位、`OldPage` 已不存在），此时改同一处容易与进行中的重构冲突。核实结论：**数据都没有丢**（快照里 jobs 含全部状态、引用锚点仍合法），只是这一页没显示／没清空。

## 本轮实跑过的证据

- `pnpm typecheck`、`pnpm lint`、`pnpm test`（46 文件／240 项）通过；`pnpm test:life-work`（真实 Electron：合成材料、暂停／熄灯、重启与私人恢复）通过。
- 新增回归：三连提交后外部编辑 → 重启 → 续做，断言无 step>3 的 attempt、无残留 running、`active() === false`；64,001 字节检查点与路径变目录下构造不抛出、用户字节不变、该项 conflict。
- 实验装置：`pnpm experiment:deeptech-grounding`（22 条）与 `--holdout --json`（44 条）均 exit 0。
- CI：`140a096`（#20）、`a80b5fc`（#16/#17）均 success。

## 未覆盖边界与遗留

- #14/#15/#18/#19 只做了核实，**没有**修；它们的复现是合成输入下的模块级实跑，不是 Electron 端到端。
- #16/#17 未跑真实 Electron 里的「冲突 → 续做」点击链路，也没有在真实 profile 里跑完整启动（`app.exit(1)` 分支为静态确认）。
- #20 遗留两项跨线问题未处理：`docs/research/deeptech-grounding-experiment-20261017.md` 与 `AGENTS.md` 写的「32 条对抗＋20 条良性」与脚本实际的 24＋20 不一致；把该 experiment 加入 CI 需要改 `package.json`／workflow。
- #16 与 #17 的 issue 正文被审计写反了（各自装的是对方的内容），已把两段正文对调回与标题一致，标题未动。

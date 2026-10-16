# 自动审计问题复核与修复

来源为 GitHub 的 #1–#5，审计基线 `3f0cf2d`；本次从 `bb1eb52` 复核。审计是静态追踪和独立替身探针，本记录另列仓库回归证据，不混作同一次验收。

| 问题 | 当前修复 | 本轮证据 |
| --- | --- | --- |
| [#1 心流退出超限](https://github.com/3067997259-design/love-college-agent/issues/1) | `f3cb836`：按实际序列化字符预算保留文件／运行索引和总数，完整记录仍在日志 | 先复现 unavailable；12 次长路径写入＋12 次运行重启后可退出，摘要为有效 JSON、≤2,000 字且不含文件正文；Vitest＋原生探针 |
| [#2 跨日旧 seq](https://github.com/3067997259-design/love-college-agent/issues/2) | 已在审计之后的 `4952553` 修复：sessionId＋局部 seq 映射到全历史位置 | 本轮重跑原生 Electron／SQLite：昨天高 seq、压缩、关库、跨日重新开库、今天低 seq；新旧工作层都在输入，退出后工作层不串回正常聊天 |
| [#3 失败书桌写入](https://github.com/3067997259-design/love-college-agent/issues/3) | `4952553` 已分离 intent／settled，本轮 `d0c4a3a` 补写入前和存档导入／导出校验 | 中文 64,000 字节边界、超限、NUL、孤立代理项、磁盘失败；旧失败意图可保留，非法已应用快照在替换数据前拒绝；真实 SQLite 导出→恢复不重放失败写入 |
| [#4 同时外出](https://github.com/3067997259-design/love-college-agent/issues/4) | 接口 `6040797`＋实现 `023e08b` | 见下；原生跨日关库重开验证旧提议取消和单次出发 |
| [#5 恢复日漏补算](https://github.com/3067997259-design/love-college-agent/issues/5) | `74867b8` | 见下；原生 SQLite 重开验证周六 17:00→周日 16:00 及再次启动不重放 |

最终功能源码基线 `4139af6`。本轮 `pnpm typecheck`、`pnpm lint`、`pnpm test`（38 文件／182 项）通过；构建后运行 `smoke-electron`、`smoke-heart-flow`、`smoke-backup` 三条完整 Electron 场景通过；`probe:heart-flow`、`probe:backup`、`probe:life` 原生探针均通过。使用合成输入／fake 模型和加速时钟，没有真实模型、邮箱或 Rodin 调用。

GitHub #1–#5 已于 2026-10-17 01:51（GMT+8）关闭。[功能基线 CI](https://github.com/3067997259-design/love-college-agent/actions/runs/38942583688) 已完成，结论 success。main 上其他工作留下的记忆实验、审计材料与未提交改动未纳入本批提交。

安装包已于 01:52 重建并通过 `pnpm test:package`：解包／实际安装各跑七类原生探针，包含本次长路径退出、跨日上下文、失败书桌写入恢复和外出边界；实际安装后的 UI 重启也通过，测试实例已卸载。产物为 `D:\lca-gpt\release\Love-College-Agent-0.1.0-Setup.exe`，238048576 字节，SHA-256 `20d95261089b5b3ba2c3dae168ec59d8cd920c9656e4a4378408229d735dc485`，实测 NotSigned。报告为该 worktree 的 `test-results/package-report.json`。这属于本机安装验收，尚非另一台干净机器验收。

## 外出接口增补

`src/shared/state.ts` 的 `OutingView.status` 新增 `cancelled`：尚未出发的提议跨上海日历日期失效，`settledAtMs` 是代码取消它的时刻。取消不代表出发／回来，不生成物品或返程经历。旧状态值继续支持；界面只对 `proposed` 展示出发按钮。该接口先单独合 main，再接主进程行为。

接口提交 `6040797`，已合 main。主进程在结算和命令入口同时作废跨日提议；自动／手动出发共用单次外出守卫。旧版本如已存下重叠外出，启动时在既有结算水位提前结束，不按离线空档继续增加行程；地点按剩余活动外出推导。新增三项 Vitest 覆盖跨日提议、未到下一调度 tick 的确认、连续确认和旧重叠状态修复；外出共六项单测、类型、定向 lint 与原生 `probe:life` 通过。

## 离线日期边界（#5）

将循环起点对齐上海午夜，枚举覆盖的日历日，再检查出发不早于离线水位／72 小时截断、返程不晚于启动时刻。先复现周六 17:00 或 23:50 关闭、周日 16:00 恢复时误生成在线提议，再验证两种输入都补回周日 15:00–16:00 的已结束外出。另测跨午夜、截断与重复启动。外出共九项 Vitest、类型检查通过；扩展原生 `probe:life` 实际关闭／重开 SQLite 和跨日 journal，验证旧提议取消、连续确认拒绝、到达日离线结算和重启防重。私人恢复继续不补空档。

# 研究与实验

保留可复现的实验装置与反例，生产能力以实际集成和对应测试为准。以下历史结果没有在文档整理时重新运行。

当前架构研究：[真实项目工作区与 DeepSeek Harness 对照](harness-workspaces-20261019.md)（2026-10-19）。覆盖原地项目访问、权限与审批、工具闭环、长任务，以及官方 SDK 作为独立执行后端的实际缺口；目前为源码研究，未运行或接入新后端。

接入前审计：[聊天、工作与生活的上下文连续性](context-continuity-audit-20261019.md)（2026-10-19）。核对两段冻结、本日会话、世界事件、工作退出与缓存观测；33 项合成现状检查复现分离行为，不代表连续性验收通过。

执行计划：[一天一条时间线：审计与 demo 执行计划](day-timeline-demo-20261019.md)（2026-10-19）。审计困惑入口、任务缺位、安全分隔、邮件入口、缓存观测和她自己的生活，把设计写成七个待验证的问题，先在分支上做可复现的 demo；设计为建议，尚未实现。

D1 任务对象：[任务对象契约与实施清单](day-timeline-d1-task-20261019.md)（2026-10-19，demo 分支）。日志记录、共享视图与投影已落地并有重启测试；模型提议工具、任务卡与剧本场景按切片推进。

D2 安全清单：[一条时间线与安全的实施清单](day-timeline-d2-20261019.md)（2026-10-19，demo 分支）。已完成：一条时间线、固定工具列表、任务书桌授权、降级回合与一次性原文；`test:timeline-safety` 剧本与单测通过。

D3 接收与注意力：[接收、唤醒与注意力的实施清单与进度](day-timeline-d3-20261019.md)（2026-10-19，demo 分支）。已完成：回合内全量接收、专注续跑上限与停止条件、attention 调度点与生活作品让位；Q7 前半剧本通过，休息交班随 D4。

| 入口 | 研究问题 | 已知边界与历史记录 |
| --- | --- | --- |
| `pnpm probe:deeptech-audit` | 结构守卫、来源权限与依赖新鲜性 | 只读代码结构检查，不调用模型。[原审计](https://github.com/3067997259-design/love-college-agent/blob/hackathon-2026-final/docs/research/deeptech-memory-audit-20261017.md) |
| `pnpm experiment:deeptech-memory` | 多种摘要 / 记忆产物之间的过期引用 | 冻结样例上的一致性对照，不代表真实模型质量。[记录](https://github.com/3067997259-design/love-college-agent/blob/hackathon-2026-final/docs/research/deeptech-memory-experiment-20261017.md) |
| `pnpm experiment:deeptech-grounding` | 逐字包含与语义接地的差别 | 可枚举作用域规则和合成句对照，不外推为通用中文蕴含。[记录](https://github.com/3067997259-design/love-college-agent/blob/hackathon-2026-final/docs/research/deeptech-grounding-experiment-20261017.md) |
| `pnpm experiment:deeptech-flow-undo` | 保留后续修改的非尾步选择性撤销 | 脚本自带参照实现，生产集成已撤回；不能宣称产品已有此能力。[反例与结果](https://github.com/3067997259-design/love-college-agent/blob/hackathon-2026-final/docs/research/deeptech-flow-undo-experiment-20261017.md) |

光学记忆实验主要检查主线、细节、错误确信与线索回忆；OCR 字符准确率不等于可靠遗忘体验。先导实验出现编号误认和无依据断言，默认产品仍使用文字分层记忆。完整材料见 [冻结研究目录](https://github.com/3067997259-design/love-college-agent/tree/hackathon-2026-final/docs/research)。

历史冻结记录留在归档引用，当前研究进展可继续在本目录维护。新实验先记录问题、基线、数据划分、预算与停止条件，再执行；外部服务调用需要独立授权。

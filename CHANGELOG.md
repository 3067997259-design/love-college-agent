# 更新记录

## 0.2.0 — 2026-10-19

- main 转为 AfterRain 个人长期维护主线，重整使用、开发、设计、隐私、测试和维护文档。
- 初始交付保存在 `Hackathon` 分支与 `hackathon-2026-final` 标签；竞赛专用材料退出当前目录，来源与历史入口保留。
- 模型缓存观测：解析 DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 与 OpenAI 兼容的 `prompt_tokens_details.cached_tokens`，归一为 `model/attempt` 的可选字段 `cachedInputTokens` / `uncachedInputTokens`；旧日志继续可读。
- M1 缓存观测真实验收：授权真实调用确认两种缓存 usage 形状都按原始值写入 `model/attempt`（DeepSeek 命中 1,280 / 未命中 244；OpenAI 兼容 `cached_tokens` 命中 4,224 / 未命中 1,445；首次显式 0 保留），journal 重启可读，不回报缓存字段的供应商保持未记录。命中率与成本结论仍留 D0 / R1。
- D1 任务对象：任务/计划/批准/专注/步骤/检查点/关闭的事实与投影、对话流任务卡、任务剧本。
- D2 一条时间线与安全：去掉心流区间过滤；全天固定工具列表与调用时任务授权；降级回合事实（`turn/degraded`）、一次性原文 `context.reveal`、未授权写入拒绝、书桌输出不进记忆；心流面板入口退役，旧记录只读。
- D3 接收、唤醒与注意力：运行中回合接收全部待处理事件，安静节拍只决定能否唤醒；专注中已批准任务按每段预算续跑，遇提问/失败/审批即停；新增注意力调度点，生活作品让位与左页姿势统一取自它。
- D4 交班：专注结束由模型用 `task_handoff` 提交结构化检查点，代码校验决定引用并附文件/命令/作品证据；失败写证据兜底；检查点成为请求 B 段；跨天从检查点恢复，旧授权需重新批准。
- 本版是 demo 验收版，D5 真实模型验收与后续体验调整尚未完成。

[版本详情与验证范围](docs/releases/0.2.0.md) · [全部 Releases](https://github.com/3067997259-design/love-college-agent/releases)

## 0.1.10 — 2026-10-18

- 一体校园助手、来源与回合生命周期、上传即时读取。
- providers 导入兼容、热配置与隐私路由修复。
- 工具编号复用、资料时限与失败分类修复。

[版本详情与验证范围](docs/releases/0.1.10.md) · [全部 Releases](https://github.com/3067997259-design/love-college-agent/releases)

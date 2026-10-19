# 更新记录

## 未发布

- main 转为 AfterRain 个人长期维护主线，重整使用、开发、设计、隐私、测试和维护文档。
- 初始交付保存在 `Hackathon` 分支与 `hackathon-2026-final` 标签；竞赛专用材料退出当前目录，来源与历史入口保留。
- 文档重整轮次不改变应用业务、数据格式或版本号，不重打安装器。
- 模型缓存观测：解析 DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 与 OpenAI 兼容的 `prompt_tokens_details.cached_tokens`，归一为 `model/attempt` 的可选字段 `cachedInputTokens` / `uncachedInputTokens`；旧日志继续可读。
- M1 缓存观测真实验收：授权真实调用确认两种缓存 usage 形状都按原始值写入 `model/attempt`（DeepSeek 命中 1,280 / 未命中 244；OpenAI 兼容 `cached_tokens` 命中 4,224 / 未命中 1,445；首次显式 0 保留），journal 重启可读，不回报缓存字段的供应商保持未记录。命中率与成本结论仍留 D0 / R1。

## 0.1.10 — 2026-10-18

- 一体校园助手、来源与回合生命周期、上传即时读取。
- providers 导入兼容、热配置与隐私路由修复。
- 工具编号复用、资料时限与失败分类修复。

[版本详情与验证范围](docs/releases/0.1.10.md) · [全部 Releases](https://github.com/3067997259-design/love-college-agent/releases)

# 设计参考与来源

本文说明机制和素材的来源，区分独立实现、外部依赖与体验参考。具体依赖许可见 [第三方说明](../THIRD_PARTY_NOTICES.md)。

| 来源 | 对本项目的帮助与边界 |
| --- | --- |
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 回合、步骤、收件箱和插件装配的机制参考；实验开关下以 fork 作为工作与对话的执行运行时，LCA 行为写成外部插件，见 [DSH 接入 spike](research/dsh-fork-spike-20261019.md)。 |
| [AIRI 与维护者 fork](https://github.com/3067997259-design/airi) | 记忆抽取、纠正、晋升、持续执行和界面信息分组的参考；记忆设计亦受 Neko DevLog 启发。参考结果不作为 LCA 的运行验收。 |
| Student Hub | 维护者独立开发的校园后端，通过插件适配；后端、Python、登录与个人数据库不内置到应用。 |
| [mcpfabric 上游](https://github.com/Etoryx/mcpfabric) 与 [维护者 fork](https://github.com/3067997259-design/mcpfabric) | 标准 MCP 游戏联动研究，保留实验实现，不作为普通使用或校园主线的前置依赖。 |
| [Nestopi《放松时光》](https://www.nestopi.co.jp/chillwithyou/) | 安静共处、专注节奏与低打扰体验参考，不复制角色、音乐或背景。 |
| Neuro-sama | 持续生活、主动交流和长期记忆的体验参考，不声称复现其内部架构。 |
| 角色 PV 与手绘动画 | 书、颜色、共同经历与重逢等抽象叙事意象；不复制具体造型、镜头或原图。 |

桃子源自维护者原创角色卡 ReLU 的改编；含私人信息的原卡不公开。画面使用 NovelAI / GPT-image 等工具生成并人工选定，差分与采用范围由 `art/` 记录；工具未提供版本时不作版本断言。

Windows 命令隔离参考公开平台 API：[AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)、[隔离资源边界](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。原生 helper 与主进程写回在本工程实现。

旧调研包含精确源码固定点、反例与实验条件，见 [冻结调研索引](https://github.com/3067997259-design/love-college-agent/blob/hackathon-2026-final/docs/reference-research.md)。那些记录只证明对应时间的阅读或实验，不证明外部项目当前状态；继续研究前重新核对。

不迁移参考工程的私人资料、认证或正在运行的实例。后续具体代码复用需按对应来源记录许可和范围，与原先仅参考机制的记录分开。

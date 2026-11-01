# AIRI 记忆系统直接复用评估

日期：2026-11-01。LCA 分支：`codex/continuous-work-p0`。状态：源码与既有验收记录核对完成，尚未接入运行时。

后续按用户要求，将记忆迁入与连续协作、日历摘要、聊天／工作交接合并为 [统一升级计划](lca-continuity-memory-context-plan-20261101.md)。本文件仍作为完整 AIRI 复用清单和历史测试证据入口；具体施工顺序以统一计划为准，日记本轮保持原行为。

用户进一步收敛方向：当前主要问题是记忆；优先直接复用自己修改过的 AIRI，接受向量模型、镜像等带来的复杂度，不另写一个功能更复杂的简化版本。此次评估以 `D:/airi` 的 **mods** 分支为准。

## 1. 决定与上一版方案的修正

**推荐完整复用 AIRI 的记忆机制与测试资产，集中适配宿主。** 算法、事实模型、仓储、向量生命周期、纠正、晋升和镜像队列已经存在，没有必要在 LCA 重新设计一套近似实现。

- 取消上一版默认“沿用 LCA SQLite 重写记忆 repository”的建议。先保留 AIRI 的 DuckDB 仓储与 SQL，验证主进程拥有的执行宿主；只有具体不兼容才调整驱动。
- 向量模型接入与 pgvector 镜像都纳入完整迁入范围。未配置镜像时本地仍可工作是原实现的职责划分，不表示删除镜像功能。
- 分批接线只是施工顺序，完整迁入清单不缩减为目录、几条偏好与字面检索。
- 生活、日记暂不扩展独立重构；保留现有消费者的输入与调度兼容。先验证完整记忆迁入，再按统一计划推进持续工作与上下文回流。

此文更新 [综合探索计划](lca-character-continuity-exploration-20261031.md) 的实施优先级和复用方式。先前对 LCA 断点的源码观察仍保留，不把其他模块都视为当前用户报告的问题。

## 2. 固定哪个 AIRI 版本

| 来源 | 本轮核对 |
| --- | --- |
| `mods` | `3a84a4fbaf6a54defe385e050be86fcb5436745b`，2026-09-27 |
| 当前 checkout | `afterrain/feat/elytra-mpc`，HEAD `229ac0de5ef03035d596387ba0a150c875344353`，在 mods 之后 15 个提交 |
| 已提交记忆差异 | 两个提交之间，`memory-core`、`memory-pgvector`、本地记忆 services、memory store 和桌面 memory-host 的差异为 0 |
| 工作区增量 | 存在未提交的记忆目录、交互、恢复与宿主修复；不能用 mods 或 HEAD 自动代表这些内容 |

以 mods 固定版建立可复用基线。当前未提交的目录 / read / remember / correct / forget 和 V3 修复，列为独立补丁集：固定文件指纹、保留相应测试，再决定合入批次。上一轮主要检查了这些新改动；它们尚未完成整体实机复验，不意味着较早的记忆主体没有经过实测。

本轮通过 `git show <固定提交>:<路径>` 读取 mods，没有切换或修改 AIRI 的工作区。28 个固定 Git 对象及两份工作区增量记录的指纹见 [证据清单](evidence/airi-memory-direct-reuse-20261101.json)。

## 3. 已有测试足以支持复用决策

以下是核对仓库中的历史记录，**本轮没有重跑这些测试**。

| 层次 | 已有证据 | 解释范围 |
| --- | --- | --- |
| 领域与集成回归 | MQ-2 默认阈值落地时，memory-core 40/40、pgvector 6 项单元、stage-ui memory 47/47 | 该轮 4 项 Postgres 集成被跳过；真实数据库证据来自另一轮，不能混算 |
| 生产检索 | 20 条隔离双语事实、九类共 90 条问题；原始 / 归一化双路、作用域和多个阈值对照 | 0.42 配置报告 recall@3 0.944；样本小且隔离，不外推为日用准确率 |
| 真实回答与纠正 | 2026-09-13 构建 Electron：跨会话、当前事实胜出、角色区分、同名人物、相似项目、否定、临时偏好、时间约束 | 自然问法与夹具修正的限定保留；这轮阈值仍是 0.5。工件号式问题仍有查仓库代替回忆的情况 |
| 行为影响 | 较早的 B / C 对照记录回答策略随已批准偏好及其修订改变，旧事实不再作为当前偏好 | 噪声召回部分通过；回答策略变化不能扩大为所有工具执行已验证 |
| 真实镜像数据库 | Docker Postgres 仓储 4/4：插入、检索、origin 幂等、修订 / 审核传播、删除 tombstone 和删除后的重投递 | 使用确定性向量；这份记录本身不覆盖自动断线恢复 |
| 持久化与恢复 | 独立打包 Electron profile 恢复非空记忆，事实 ID、作用域、来源及 768 个向量值一致；已有五表浏览器 roundtrip | embedding 使用合成响应；不等同真实 provider 质量 |
| 后续大范围增量 | 当前工作区验收记录包含两路线各 90 条检索、91 组同向量回放一致、故障注入 6/6，以及真实断线、进程中断和恢复检查 | 新版交互 / V3 仍有明确待复验项。后续 91 项离线修复通过不替代其实机复验 |

mods 的主要证据路径：

- `docs/fork/MEMORY-RETRIEVAL-AND-PERSISTENCE-PLAN.md`
- `docs/fork/MEMORY-BEHAVIOR-SLICE.md`
- `docs/fork/mq-2-spec.md`
- `docs/fork/evidence/mq-2/threshold-evaluation-20260912.md`
- `docs/fork/evidence/mq-2/increment-3-live-20260913.md`
- `docs/fork/evidence/mq-0/postgres-integration-20260907.md`
- `docs/fork/evidence/md-2/non-empty-memory-restore-20260907.md`

工作区增量另见 `docs/fork/memory-interaction-acceptance-20261026.md` 与 `memory-v3-state-repair-20261029.md`。这些证据说明已有大量值得保留的工程成果。接入 LCA 时重点重验改变的宿主边界，并搬入原测试和失败样本；不从零发明另一套验证标准。

## 4. 哪些直接保留，哪些必须适配

| 部件 | 源码入口 | 复用方式 |
| --- | --- | --- |
| 完整领域核心 | `packages/memory-core` | 保留事实 / 来源 / 作用域、抽取契约、评分、衰减、晋升、梦境与反射筛选、查询归一化和评测集；调用方提供 LCA 时间，避免产生独立业务时钟 |
| 本地记忆仓储 | `stage-ui/src/services/memory/local-memory.ts` | 保留查询、状态过滤、向量元数据、SQL 与结果映射；已有 `MemoryDbExecutor.execute()` 边界。剥离同文件中 AIRI plan 持久化的耦合，不移植其完整工作系统 |
| DuckDB 生命周期 | `stage-ui/src/composables/use-duck-db.ts` | 保留 schema、迁移、checkpoint、快照和关闭语义；Vue ref、浏览器 OPFS、leader 窗口选择需要改为 LCA 主进程控制的独立存储宿主 |
| 记忆编排主体 | `stage-ui/src/stores/modules/memory.ts` | 从 Pinia store 提取现有操作实现；保留双路召回合并、纠正、晋升、重新嵌入、梦境、镜像 outbox 与退避，替换设置 / journal / 时钟 / 生命周期的宿主调用 |
| embedding 通道 | `stage-ui/src/services/memory/local-memory-embedding.ts` | 保留本地 / API 接口、document 与 query 区分、来源指纹和维度契约；把浏览器 worker 导入与密钥管理适配到 LCA 后台服务 |
| pgvector 仓储 | `packages/memory-pgvector/src/repository.ts`、`schema.ts` | 复用仓储子入口及集成测试。避免引入包根入口的 AIRI server-sdk 服务启动链 |
| 桌面镜像连接 | `stage-tamagotchi/.../memory-host/index.ts` | 保留连接、状态与仓储操作语义；Eventa 接线和连接凭据文件替换为 LCA 主进程服务，不让 renderer 接触连接串 |
| 新版目录与对话操作 | 当前工作区 `memory-core/interaction.ts`、`services/memory/interactions.ts` 等 | 作为来源明确的增量复用；保留已有操作 ID、版本和回执测试，不自行写一个弱化版本来替代 |

两个 memory 包均为仓库内 `private` 包，使用 workspace / catalog 依赖；目前不是给 LCA 直接安装即可启动的独立 SDK。memory store 约 1,800 行，里面混合了业务和宿主状态，不能仅复制 `memory-core` 后把其余功能写成 LCA 的另一套规则。

推荐先采用**固定来源的代码副本加可审查补丁**：在 LCA 维护原路径、源提交、哈希、MIT 许可与修改说明，保持领域与仓储差异尽可能小。提取出的运行时长期可独立成包；本轮不要求用户先整理或提交 AIRI 的脏工作区，也不让 LCA 日用时从 `D:/airi` 动态加载文件。

## 5. 需要接受和管理的复杂度

**向量来源是完整模块的一部分。** 保留已实现的 provider / model / dimensions / input type / fingerprint / status 及断点迁移。当前接口支持 768、1024、1536 维；不默认任意模型兼容。换向量模型不直接继承旧阈值的质量结论。保留本地和 API 两种路线，后续用明确配置接线；本轮没有下载模型、读取旧凭据或调用服务。

**镜像是独立持久组件。** AIRI 以本地记忆为权威侧，晋升和修订等通过 outbox 同步 pgvector；本地聊天检索并不因此自动改成远端检索。迁入保留完整 outbox、重试、删除与防复活语义。LCA 使用独立库 / schema 和凭据，不连接 AIRI 日用数据库。镜像未配置、离线、积压和同步完成各有真实状态。

**主进程所有权是主要适配成本。** 不能把 AIRI 的 Vue / localStorage / OPFS leader 机制直接塞进 React renderer。存储执行、后台模型连接、时钟与操作提交由 LCA main 拥有；界面只拿安全投影。可以把重 IO 放在 main 控制的后台进程，但先验证 DuckDB 驱动、Windows 打包、checkpoint 与强制结束恢复，再定具体宿主。

**语义与来源接线必须保留 LCA 合同。** `captureTurn` 的输入绑定成功模型输入中允许记忆的片段；`captureEvent` 不因为上游有接口就自动接所有校园事件或工具输出。AIRI 的匿名身份历史链接开关不自动放宽 LCA 用户 / 角色边界。日记和自动摘要不递归成为事实，旧 unreviewed 记忆不批量变成 approved。记忆操作与 LCA append-only 来源 / 操作记录建立对应，明确提交与恢复顺序。

**成本在适配探针中实测。** 记录包体、冷启动、内存、模型缓存占用、单轮 embedding 次数 / 延迟、迁移耗时与镜像积压。双路查询在归一化确实改变问题时可能增加一次 embedding；不能仅统计聊天 token。保留原功能与原对照，先识别宿主代价，不先删机制降低复杂度。

## 6. 收敛后的接入顺序

| 批次 | 工作 | 交付 / 判断 |
| --- | --- | --- |
| M0 本轮 | 固定 mods、核对历史验收、列复用边界与工作区增量 | 完整复用可行；主要成本在宿主，不建议另造简化记忆 |
| M1 原代码隔离运行 | 固定代码副本、许可、依赖与原测试；在 LCA 隔离环境验证 DuckDB 执行宿主和 embedding 导入 | 先证明原仓储及 schema 能开库、写入、checkpoint、重开；不接日用 profile |
| M2 提取原运行时 | 移出 Pinia / 窗口状态，接 Clock、设置、持久操作和向量服务；保留检索、修订、迁移、晋升与 outbox 实现 | 原测试在新宿主下等价；变更集中在依赖边界，有原始版本对照 |
| M3 接 LCA / DSH | 成功模型输入采集、同角色跨日身份、召回与正文读取、纠正 / 忘记、可理解的记忆设置和浏览 | 普通聊天确实使用跨会话记忆；用户可检查和纠正；界面使用独立向量配置 |
| M4 镜像与恢复 | 独立 pgvector 接线、断线 / 重投递 / 删除、备份恢复与模型迁移；补齐新版交互修复 | 完整模块的存储能力通过 LCA 的进程与存档边界验证，不能跳过后就宣布完整迁入 |
| M5 原评测迁移 | 同样 90 条、作用域 / 否定 / 更正 / 未知问题、行为切片、原失败反例；再按授权做真实模型与日用观察 | 分清原代码历史通过、LCA 离线通过和 LCA 真实通过；数据迁移后才逐步退役旧引擎 |

接口变更仍单独提交。第一项实施工作是 **M1：使现成代码在 LCA 的隔离宿主里运行**。存储驱动问题在这一阶段得到具体答案；不会先写新的检索 / 抽取算法来绕开原实现。

本轮只更新研究计划与来源清单，没有安装大型依赖、启动 AIRI / Docker、连接模型或数据库，也没有改变 main 与生产记忆行为。

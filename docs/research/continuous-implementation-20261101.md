# 连续协作者与完整记忆：实施记录

目标：连续完成用户计划阶段 0–6，形成可构建、关键链路跑通、具备统一验收入口的实验候选。目标保持进行中；当前不是候选版本或整体验收通过。

分支 `codex/continuous-work-p0`，本轮起点 `47721a7`。main、日用数据与日记产品行为没有进入本批修改范围。具体合同仍以 [统一计划](lca-continuity-memory-context-plan-20261101.md) 和 [完整 AIRI 复用清单](airi-memory-direct-reuse-20261101.md) 为准。

## 要求与当前证据

| 阶段 | 当前状态 | 证明与剩余工作 |
| --- | --- | --- |
| 0 来源与接口 | 核心契约和来源固定 | `03c0945` 独立提交共享 owner、工作代次、引用版本、投递／记忆回执；当次完整 typecheck 通过。AIRI 40 个基线文件、17 个增量文件逐字节固定；24 条故事预先登记。统一验收脚本可枚举缺项。后续消费方接线仍须按契约验收。 |
| 1 完整记忆宿主 | 已完成本批主进程适配与存储关卡 | 原领域、SQL、目录／交互／对账、pgvector、双路召回、衰减晋升、dream/reflex、向量迁移及原 outbox 已迁入。补齐提交协调器、镜像作用域／恢复 epoch 宿主、native 快照与交互恢复测试；Node／Electron 实际存储通过。产品配置、完整存档接线和其余恢复场景仍在后续阶段。 |
| 2 单会话接线 | 进行中 | `/compact` 已通过主进程／host／bridge 接到实际 DSH `compactNow`；原始日志不变，结果区分成功、无范围、忙碌、失败。固定运行时的合成 compact-memory 场景通过。新事实引擎尚未挂到产品 memory 服务；需继续拆经历索引／日页协调、成功输入去重和统一 composer。 |
| 3 前台与工作分离 | 待实现 | 稳定 workId 服务、双 Worker、持久订阅与投递尚未接入；执行关卡未运行。 |
| 4 两车道与经历回流 | 待实现 | 检查点即时交付、带覆盖游标的回顾、摘要更正联动及跨日故事未运行。 |
| 5 迁移、恢复与界面 | 待实现 | 尚无旧记忆迁移、新 `.lca-save`、镜像 restore epoch 或正常设置入口；恢复关卡未运行。 |
| 6 候选收口 | 待实现 | 未跑全仓单测、全量 lint、生产构建、DSH 组合回归、T1–T16 或 Windows 候选包；真实服务另需配置和预算。 |

## 本批实现

- [来源清单](../../vendor/airi-memory/manifest.json) 将固定 mods 与已选工作区增量分开。原始字节保存在 `vendor/airi-memory`，原许可证与分发规则均已加入；运行时不读取 `D:/airi`。
- `src/main/memory/airi/` 保留领域、仓储与主要编排；原浏览器存储、Pinia、Vue、auth、provider、journal 接口替换为主进程端口。只剥离 AIRI 自己的计划持久化和浏览器聊天压缩设置；DSH 将拥有模型历史压缩。原 SQL 的兼容表／列保留。
- `src/main/memory/storage/` 通过 Node Neo `@duckdb/node-api@2.0.0-r.1` 开真实文件库，主进程控制 utility process。事务租约覆盖整个 callback，其他写入与 checkpoint 排队；失败没有临时内存库回退。所有业务时间来自 Clock。
- settings／原 outbox 的本地状态采用主进程写入、fsync 后替换的文件；该状态不收凭据。稳定 operationId 将意图、数据库事务回执和 append-only 完成记录相连；重开先对账。镜像 dirty 记录与事实同事务，写入原 outbox 并 fsync 后才按版本确认，关闭数据库到状态文件之间的丢失窗口。
- 镜像仓储保持原三种向量列与算法；LCA 宿主按用户、角色、数据根和恢复 epoch 选择独立 schema，错误不回传连接串。镜像配置和投递仅用假连接测试，未连接真实 Postgres。
- 原 Parquet 快照合同已适配原生执行器：支持五表旧版与六表 v2，LCA v3 另含提交回执和镜像 dirty 记录。只向空数据库事务导入，校验回执索引；这是引擎层往返，尚非产品 `.lca-save` 验收。
- 独立 embedding 端口保留三种向量维度、模型指纹、query/document 角色和 usage；API 适配在 main 内持有密钥。无配置明确不可用，不自动下载原浏览器模型或更换向量空间。真实向量与镜像服务没有调用。
- 单个 runtime 的初始化改为共享 promise；更正后向量就绪状态绑定事实 revision，避免新事实未 embedding 时直接复用旧的就绪标记。目录仍可独立于向量使用。

## 已运行的验证与保留的失败

机器可读摘要见 [证据清单](evidence/continuous-implementation-20261101.json)。原始本机记录保留于忽略的 `test-results/continuity/`。

| 检查 | 本批结果 | 范围 |
| --- | --- | --- |
| AIRI 来源校验 | 57/57 指纹一致 | 固定源码，不证明运行行为 |
| 迁入与新增记忆相关测试 | 144 通过，4 Postgres 集成跳过 | 原算法、原编排 36 项、原交互 12 项、提交中断／恢复、假 provider／mirror、真实 DuckDB；没有真实模型或镜像连通声明 |
| Node 真实文件存储合同 | 通过 | 向量、作用域、事务回滚、排队、checkpoint、纠正、删除、重开 |
| Electron utility process 存储合同 | 通过 | Electron 44.7.0／Node 24.21.0，三次独立 utility process 开库，原生驱动实际加载 |
| 主进程 TypeScript／本批 ESLint | 通过 | 新宿主、编排、测试与脚本；不是全仓 lint 或生产构建 |
| DSH 定向压缩 | 合成服务流程通过 | 同一 root 的真实 DSH 摘要调用、持久压缩、旧引用退役与下一回合新引用；4 次本地脚本请求，含摘要预算放行；无真实模型 |

保留的失败与修复：

1. 初始 Node 夹具使用批准前 revision 写向量，被仓储正确拒绝。夹具改为读取批准后 revision，并保留拒绝迟到向量的断言。
2. Electron 首两次在 Codex 沙箱的 AppContainer 安装目录访问检查退出，未进入场景；本地二进制目录只读权限修复后，正常用户进程权限下运行隔离 probe 通过。未关闭 Electron sandbox。
3. 原编排测试迁入时，夹具反复反序列化队列导致对象身份变化；修复测试宿主保持 cell 身份，并补全恢复 hold 的注入。原断言保留。
4. 原生 runtime 正例发现更正后立即召回为空；修复向量就绪 revision 后，同一用例与原编排回归通过。此项是运行时修复，未改 oracle。
5. 组合测试发现 repository Proxy 对不存在的 `then` 也返回函数，导致初始化被当成 Promise 挂起。改为仅包装实际方法，四项 owning-engine 测试通过；初始超时记录保留。
6. compact 原始夹具把协议补充消息误当最后用户输入，改为定位带场景标记的实际用户消息；原本的真实压缩已成功。随后 host 单测发现 `compacted` 未加入响应分派，修复后相关 79 项测试通过。两次失败记录均保留。

原浏览器 interaction 12 项断言已迁为 native 场景；设置与 embedding 的 native 对应覆盖无凭据恢复、读者不改设置、provider 阻塞时精确读取。剩余浏览器多窗口细节不进入 renderer，需在后续主进程／preload 产品场景验证；不能将上表说成原浏览器套件全部原样运行。

## 统一验收与故事

```powershell
pnpm verify:airi-memory
pnpm test:continuity:storage
node scripts/accept-continuity.mjs --list
pnpm test:continuity
```

存储入口只执行离线记忆相关测试和 utility-process 合同。完整候选入口顺序执行 typecheck、lint、单测、固定 DSH bridge／family／collaboration、一次生产构建及现有 Electron 场景，最后要求 `scripts/smoke-continuity.mjs`。该 T1–T16 脚本尚未实现，所以当前完整入口在预检阶段失败，明确列出缺项，不能输出候选 PASS。各任务保存独立日志和源码指纹；执行期间源码变化则停止。现有 Electron 脚本的统一端口／数据根参数还需在后续接线时核对。

[24 条故事](../../tests/fixtures/continuity-stories.json) 每类 4 条：偏好、更正、决定理由、刚完工、长期任务、未知问题。它们是预登记的场景描述和 oracle，尚未执行；其中检查点、工具回执、日切等必须通过真实边界产生，不能伪装成用户消息直接注入。金标准不进入模型提示。原 90 条评测保留在 AIRI 原始领域代码中。

## 迁移与回退现状

本批尚未打开日用数据或切换生产写入引擎。隔离 probe 的 DuckDB、状态与日志留在其独立测试目录，不能复制为用户 profile。当前可按功能提交回退宿主与依赖；不得删除这些测试失败证据。最终切换前仍必须实现非空旧数据迁移、日志／DuckDB 对账、新存档与恢复 epoch；切换完成后才退出旧引擎写入。

下一实施落点：单会话成功输入采集、经历／日页拆分、上下文组装与 DSH compact；存储证据不能跳过执行、恢复与整场景关卡。

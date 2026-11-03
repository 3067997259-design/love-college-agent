# 候选 8 记忆与 Voyage 复测准备

2026-11-03，用户要求完成统一回归并开始下一项记忆／Voyage 复测。这里记录离线准备和待授权范围；不继承已经关闭的工作或旧记忆批次额度。生产候选仍固定为 `1.2.0-continuity.8`，不生成或发布新包。

## 两个顺序子批次

1. **向量参数检查**：复用生产 embedding 适配器，在隔离 Electron 主进程中对两条短合成文本分别调用 `document` 和 `query`。检查真实发出的参数、完整响应、合法且一致的向量维数及实际用量。它是适配器服务探针，不冒充普通产品场景，也不据此判断检索质量。
2. **普通产品记忆故事**：复用现有 `probe-memory-live.mjs`，依次覆盖记住／审阅／召回、更正退役、实际 DSH 压缩、重启、成功原始输入抽取去重、忘记、非空存档恢复后不复活。逐条复核十条回答，采用原子语义审阅发布器。

两个子批次使用新目录和独立账本。参数检查先运行；任一请求或断言首次失败即关闭整个窗口，后续子批次不启动，不自动重试或使用剩余额度。真实配置只由获授权的 Electron 主进程读取，密钥不进入报告、命令行或 renderer。

现有普通产品探针经 localhost 网关转发，产品按通用兼容接口组装请求；这一车道仍不证明 Voyage 可选参数。参数检查保留真实 Voyage endpoint 的识别，并直接调用生产适配器，单独填补该缺口。官方接口允许 `input_type` 为 `query`、`document` 或省略；参考 [Voyage embeddings API](https://docs.voyageai.com/reference/embeddings-api)。

## 待授权上限

| 子批次 | 模型请求 | 向量请求／输入字符 | 总预留单位 | 其中自主单位 |
| --- | ---: | ---: | ---: | ---: |
| 参数检查 | 0 | 2／2,000 | 10,000 | 10,000 |
| 产品记忆故事 | 32 | 48／200,000 | 1,048,576 | 262,144 |
| 合计 | 32 | 50／202,000 | 1,058,576 | 272,144 |

自主额度包含在总额内。预留单位是准入估计，不是账单金额。额度批准与包／探针指纹绑定；模板在用户授权前保持 `authorized:false`。

## 准备状态

[完整统一回归](continuity-candidate8-regression-20261103.md)已通过。候选 8 的记忆产品预跑七组、参数探针两项、17 项相关单测与两项运行器保护检查均已通过，外部请求为 0。原始目录位于 `D:/lca-continuity-candidate-20261101/profiles/`：

- `memory-candidate8-selftest-20261103-1`：27 次本地模型、30 次合成向量请求。
- `embedding-candidate8-selftest-20261103-2`：两种参数的 1024 维合成响应通过；第一次加载失败目录保留。

授权模板位于 `test-results/continuity/candidate8-memory-ready-20261103/`，绑定原包、预检和探针指纹。旧模板保留 `authorized:false`；用户随后明确选择“授权这一批”，另生成批准文件。总授权 ID 为 `9b3c974e-6903-4987-9cb3-a679b0f75dbc`，时间为 `2026-11-03T03:37:00.956Z`。真实结果为：参数两项通过，记忆前六组通过，恢复后最终答复的第 33 次请求触及 32 次上限。窗口已经关闭，余额不复用；见[实际结果与停止原因](continuity-candidate8-memory-live-20261103.md)。

参数入口的离线命令为 `node scripts/probe-embedding-inputs.mjs --self-test`，需指定固定包的 `LCA_TEST_EXECUTABLE` 和新的 `LCA_EMBEDDING_PROBE_RUN`；`--prepare <通过的离线目录> <新模板文件>` 只生成未授权模板。真实模式另要求 `LCA_REAL_EMBEDDING=1`、批准的 `LCA_CONTINUITY_AUTH_FILE` 和主进程可读的 `LCA_MEMORY_CONNECTION_FILE`。实际连接模型必须为本批指定的 `voyage-4-large`。运行目录与授权只允许使用一次。

范围不含原 90 条检索和新增 24 条多回合故事的完整质量／成本矩阵，也不含实际安装升级、第二台 Windows、真实经过多日或长期日用。

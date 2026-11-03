# 候选 8 恢复尾段补测：真实窗口停止，流诊断离线修复

2026-11-03，用户批准补测[上轮记忆故事](continuity-candidate8-memory-live-20261103.md)缺少的恢复后最终回答。**非空恢复和退役／忘记状态再次通过；真实回答未完成。** 首个模型流没有在应用中产生回答或工具调用，后续 HTTP 尝试缺少新的应用准入回执，被网关拒绝。本窗口已经关闭，没有继续转发或复用余额。

随后仅做离线复现和探针修复：空流和流内错误现在在首个请求处明确失败；正常恢复尾段五项检查、28 项相关单测、主进程类型检查和改动路径 lint 通过。真实尾段仍待新的授权窗口，不能用离线通过替代。结构化回执、原报告哈希及各次探针指纹见[证据文件](evidence/continuity-candidate8-memory-restore-20261103.json)。

## 固定范围与用量

候选仍为 `1.2.0-continuity.8`，asar SHA-256 为 `b4620f1409cca9e99216a89d1d08d43b2b5257a6faf7c7f0e60091367ab6bf14`。生产源码、候选包、main、日用配置及数据未改动；没有安装、打包或发布。

新增 `scripts/probe-memory-restore.mjs` 只恢复原故事产生的非空存档，在全新 profile 和账本中完成最后问答，不重跑前六组，不续用旧账本。源文件为 `D:/lca-continuity-candidate-20261101/profiles/memory-candidate8-live-20261103-1/nonempty.lca-save`，49,670 字节，SHA-256 为 `5566af01d6912fd88c18846a0171c006ef7aa504f14cb2d703e847139dc4963c`；运行后重新核对哈希不变。

| 指标 | 授权硬上限 | 本轮实际 |
| --- | ---: | ---: |
| 模型请求 | 6 | 1 |
| 向量请求／输入字符 | 12／20,000 | 3／154 |
| 总预留单位 | 196,608 | 22,602 |
| 其中自主单位 | 65,536 | 6,602 |

自主单位包含在总额内，预留单位不是账单金额。授权 ID 为 `974edbba-b36b-4d2c-9efb-4e35b5b9c8b6`。真实目录为 `D:/lca-continuity-candidate-20261101/profiles/memory-restore-candidate8-live-20261103-1`；`closed.json` 记录在途 0、收尾无不确定项、`reuseAllowed:false`。4 个外部请求均返回 HTTP 200，但 HTTP 状态和流结束标记不证明模型生成成功。

## 实际失败与结论边界

恢复后当前已审阅事实为 0，旧茶偏好仍为 superseded，记住、更正、忘记操作均为 applied。此次只查询当前已审阅记忆，原始问题为“恢复存档之后，只查询当前已审阅记忆：还有我的饮料偏好吗？”

首个模型请求耗时 84.649 秒。旧网关记录了两个 SSE 帧、一个 `[DONE]`，未见 `finish_reason`，却因终止标记将该请求写为 `ok:true`。应用没有交付回答或执行记忆工具。随后出现新的 HTTP 请求，日志中没有对应的新 `model/attempt` 准入；原票据已经消费，网关以 `APPLICATION_ADMISSION_AMBIGUOUS` 拒绝，未转发该请求。产品最终显示 configuration-failed；这是本地网关的拒绝，不是 provider 的 HTTP 403。

旧探针没有保存原始响应，因此不能断言真实首帧究竟是空 choices、元信息、推理内容或流内错误。**确定的是：终止标记被误当成可用输出证据，真实回合未完成。** 离线返回“空 choices 帧＋`[DONE]`”可复现完全相同的再次请求和准入拒绝，但这不能证明原服务的具体载荷或根因。

原始失败报告保持 `ok:false`，只有恢复前置两项为 true；没有补写最终回答或语义通过记录。报告 SHA-256 为 `1b81d70c3852af061343d38568cfee74375c0f0a5147b63ad99b92c9127231fa`。

## 实现与离线验证

恢复入口通过普通产品的导入、确认、实际冷启动和聊天入口执行。它校验真实 `memory.search/read` 完成回执、事实与操作不复活、原始消息保留；真实回答还需单独语义审阅。授权绑定存档、候选包、探针源码与 bundle 指纹、通过的预检报告。旧完整记忆授权和改变存档的授权均在启动应用前被拒绝。

网关修复区分终止标记与有效输出，检查正文、工具调用或拒绝回答；只有 reasoning 不算可交付输出。空流记为 `EMPTY_MODEL_RESPONSE`，SSE 中的 error 记为 `PROVIDER_STREAM_ERROR`。失败也保留帧数与内容类别等结构信息，不保存正文、推理或上游错误原文。没有放宽应用准入，也没有增加真实重试许可。故障注入仅允许 `--self-test`。

| 离线场景 | 结果 | 本地请求（模型／向量） | 外部请求 |
| --- | --- | ---: | ---: |
| 修复前空流复现 | 重现 `APPLICATION_ADMISSION_AMBIGUOUS` | 1／3 | 0 |
| 修复后空流 | 首次即 `EMPTY_MODEL_RESPONSE`，没有再次准入歧义 | 1／3 | 0 |
| 修复后流内错误 | 首次即 `PROVIDER_STREAM_ERROR`，没有再次准入歧义 | 1／3 | 0 |
| 修复后正常恢复尾段 | 五项检查通过，包含实际查询工具和最终回答 | 2／4 | 0 |

最终三个目录分别为 `memory-restore-fixed-empty-20261103-1`、`memory-restore-fixed-error-20261103-1`、`memory-restore-fixed-positive-20261103-1`，均位于上述 profiles 根目录。故障场景按预期保留 `ok:false`；不改写为业务通过。正向预跑五项为：非空恢复、退役／忘记状态、当前记忆查询和答复、事实与操作不复活、原始历史保留。

相关单测为 `continuity-live-budget`、`world-probe-stream`、`probe-response-deadline`，共 28 项通过；`tsc --noEmit -p tsconfig.node.json` 与七个改动代码／测试文件的 ESLint 通过。没有重复全量构建或宣称再次完成整场统一回归。

## 再次补测入口

离线执行 `node scripts/probe-memory-restore.mjs --self-test`，先设置固定包 `LCA_TEST_EXECUTABLE`、新的 `LCA_CONTINUITY_PROBE_RUN` 和 `LCA_MEMORY_RESTORE_ARCHIVE`。随后 `--prepare <通过的预检目录> <新的授权模板路径>` 生成 `authorized:false` 模板；故障预检不能生成模板。

最终模板为 `test-results/continuity/candidate8-memory-restore-fixed-ready-20261103/authorization.proposed.json`，绑定正常预跑报告 SHA-256 `bcf92004080510e6c2eb0afdedf91302f45ef736ab298e93860f4d5fff7a5e4a`。下一窗口仍仅补这一段，上限沿用 6 次模型、12 次向量／20,000 字符、196,608 总单位，其中自主 65,536；首次失败即停。真实模式另需批准文件、`LCA_REAL_MODEL=1` 及授权主进程读取的连接路径；当前模板尚未授权。

原 90 条检索和新增 24 条故事的完整质量／成本矩阵、实际安装升级、第二台 Windows 和长期日用仍分别待验。本次修复解决探针误判和诊断缺口，不代表已修复或确认真实服务端的异常根因。

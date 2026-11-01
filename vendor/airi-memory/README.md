# AIRI 记忆固定来源

来源：[AIRI](https://github.com/moeru-ai/airi)，MIT，许可全文为 [baseline/LICENSE](baseline/LICENSE)。
固定基线 `mods@3a84a4fbaf6a54defe385e050be86fcb5436745b`。
`manifest.json` 逐文件保存原始字节的 SHA-256；`baseline/` 不变，`increment/` 仅包含已选记忆目录、交互、来源对账和 V3 恢复增量。未迁入 AIRI 的其他未提交功能、配置或私人 profile。

初次导入由 `scripts/vendor-airi-memory.mjs` 从只读参考 checkout 完成，已有固定清单时拒绝覆盖。运行时不读取参考仓库。`scripts/adapt-airi-memory.mjs` 记录初次提取步骤，已有适配代码时同样拒绝覆盖。

运行代码位于 `src/main/memory/airi/`，迁入测试位于 `tests/unit/airi/`。当前适配：

- 领域算法、评分、衰减、晋升、dream/reflex、抽取和原 90 条评测保持原实现。
- 仓储的包导入改为本地相对路径；业务时间注入 LCA Clock，ID 使用主进程随机 UUID。
- 本地仓储只剥离 AIRI 的 `PlanPersistenceRepository` 及其一项测试；原测试与实现保留在固定来源中。LCA 工作状态由自己的日志管理。DuckDB 历史表与列保留。
- 浏览器 OPFS／Pinia 所有权不作为产品宿主。DuckDB SQL 从原初始化块提取，事务／checkpoint／关闭由 main 控制的 utility process 承担。
- pgvector 仓储与 schema 保留；连接配置与队列由 LCA 所有，不引入 AIRI server-sdk 服务启动入口。
- 交互回执增加可选 `previousSourceContext`，在原提案事务中保存目标事实的来源身份；旧回执继续可读。该元数据用于 LCA 经历摘要更正／忘记后的失效，不改变原事实和向量算法，也不复制已删除事实正文作为新经历。
- 宿主读取完整操作历史以保持更正／忘记来源的长期失效；界面另行限制投影数量。pgvector 同一 origin 的插入／删除使用事务锁，提前到达的删除也保存空正文 tombstone，避免迟到写入复活。向量迁移增加主进程暂停／撤销检查，连接指纹改用端点与模型的散列，不保存端点私有路径。

原浏览器测试与 store 保留作宿主改写的验收依据；复制到此目录不等于已在 LCA 运行通过。实施与验证状态见 [实施记录](../../docs/research/continuous-implementation-20261101.md)。

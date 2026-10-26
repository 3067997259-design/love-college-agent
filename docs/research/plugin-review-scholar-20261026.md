# 迁入评审：有来源的学术检索

2026-10-26，评审人 Codex；[总评与成本口径](plugin-migration-selection-20261026.md)，[规格](../plugin-migration-spec.md)。维护责任尚未认领，以下为建议。

## 1. 结论卡与证据

| 字段 | 结论 |
| --- | --- |
| 对象 | `Cjrrrrrrrr/dsh-plugins` 的 `@local/dsh-scholar@1.0.0`；commit `3d546b1dcd534ba412f5eaa7989368e0d5f5e006` |
| LCA 基线 | 总评中的 Windows / DSH 0.2.1-rc.2 / Electron 44.7.0 dirty 工作区；[相关文件 hash](evidence/plugin-migration-reviews-20261026.json) |
| 范围 | 用户显式发起 Crossref / arXiv 检索及 DOI / arXiv 标识符查询；最多 8 条有来源元数据，摘要有界 |
| 不保留 | OpenAlex / Semantic Scholar / PubMed 首轮不接；PDF 下载、Unpaywall、引文网络、图书搜索、自动综述不接 |
| 路线与影响 | M3 组件复用；F1，沿用书页工具与交付；涉及 U2 / U3 / U5 / U6 / U7 |
| 决策 | 先验证，建议优先级 1；有增量用途，复用优势有限但可检验迁入流程 |
| 证据状态 | E0 已完成所列源码与方案审查；E1–E6 未测；未取得发布制品 hash，未安装、未运行上游测试 |
| 许可 | 根 MIT 与 package 一致；采用片段告知待落实，实际制品 / 数据许可未清关 |

来源：[package](https://github.com/Cjrrrrrrrr/dsh-plugins/blob/3d546b1dcd534ba412f5eaa7989368e0d5f5e006/packages/dsh-scholar/package.json)、[工具入口](https://github.com/Cjrrrrrrrr/dsh-plugins/blob/3d546b1dcd534ba412f5eaa7989368e0d5f5e006/packages/dsh-scholar/lib/index.js)、[数据层](https://github.com/Cjrrrrrrrr/dsh-plugins/blob/3d546b1dcd534ba412f5eaa7989368e0d5f5e006/packages/dsh-scholar/lib/sources.js)、[LICENSE](https://github.com/Cjrrrrrrrr/dsh-plugins/blob/3d546b1dcd534ba412f5eaa7989368e0d5f5e006/LICENSE)。

## 2. 价值与完整流程

| 项 | 判断与依据 |
| --- | --- |
| V1 真实用途 | 成立于大学研究 / 写作场景：按主题找文献，核对某篇论文的 DOI 和年份；个人使用频率未确认 |
| V2 增量收益 | 预期成立：已有一般网页搜索不能替代结构化学术标识符、跨源合并和明确的部分失败；实际检索质量未测 |
| V3 流程适合 | 成立于上述窄范围：只增加工具，不接管工作、人格或记忆 |
| V4 可持续 | 有小模块与明确接口；维护人、外部服务稳定性和真实成本未知 |

现有方式是让 DSH 用普通网页能力找资料，再由模型解释。迁入后：用户在书页给出公开查询 → LCA 明确查询可外发及来源策略 → DSH 调用有限检索工具 → 请求层按源限速、限量 → 返回结构化来源回执与有界摘要 → 角色给出带 DOI / 链接的候选列表。查到元数据不等于读了全文；如后续形成文件，仍须有实际产物。

遇到 429 / 超时，显示具体源失败及已有结果；两源全失败不能显示“找到 0 篇”。停止后不再开新请求，已发的公开查询不能撤回。专注与交付沿用 LCA；无后台订阅。下一轮与重启退役摘要；用户问题保留，外部摘要及直接复述不自动成为个人经历。私有研究原文不能因插件叫“检索”就自动发送到公共 API。

## 3. 门槛与路线比较

| 门槛 | 状态与处理 |
| --- | --- |
| G1 职责 | 满足方案；工具仅提供数据，DSH 执行、LCA 授权与记账 |
| G2 可控执行 | 有缺口：数据层有自带网络 / 重试，需要替换；无嵌套 LLM 证据 |
| G3 宿主 | 存在具体缺口：本地工具可承载文本，但当前 `execution.ts` 的 sourceOf 只映射若干 templateId 前缀，普通新插件会得到 null；必须补明确的来源接线，并验证退役、外发与工作路由，不能只登记名字 |
| G4 许可 | MIT 片段授权路径明确，通知待落实；API 条款和返回摘要另核对 |
| G5 验证维护 | 有可执行验收计划，未运行；维护人待认领 |

| 路线 | 同范围成本与取舍 |
| --- | --- |
| 推荐 M3 | 3–6 人日：保留可读的请求构造 / 字段归一化和部分去重经验，替换网络 / schema / 结果通道；不追整个上游仓库 |
| M4 原生 | 4–7 人日：若只需要单源 DOI lookup，范围缩小后可能与复用一样便宜，届时优先简单方案 |
| 整包 M0 / M2 | 不推荐：额外带入五源配置、包内网络策略和未选功能；原样未验收，保留整包没有对应收益 |
| 暂不做 | 继续用普通网页检索；没有结构化来源保证，但零新增维护成本 |

以上为规划区间，节省未实测。来源模块虽有 469 行，行数不是工作量；首轮只采用实际需要的片段。

## 4. 改造与数据账本

| 项 | 上游依据 → 迁入处理与验收 |
| --- | --- |
| D1 包依赖 | `index.js` 只 inject tools，并动态导入 DSH helper；抽数据片段，重建 LCA manifest / 参数 schema，舍弃原 DSH 注册层 |
| D2 执行授权 | 用户显式查询；新增工具的外发与来源不能由 `paper_search` 名称推导，接既有逐次审批语义；拒绝后零请求 |
| D3 模型资源 | 无需新模型；限制每回合请求数 / 并发 / 字节及等待，模型解释走既有 DSH 额度；不自动注册 API key 或填用户邮箱 |
| D4 来源上下文 | 元数据保存 source / id / URL / retrievedAt；补主进程到 bridge 的明确来源映射，摘要以第三方来源进入当前轮，派生结果保持来源；测试下一轮 / 重启退役 |
| D5 数据作用域 | 查询和结果绑定本项目 / 本回合，不建立全局个人索引；日志仅记录可公开的有限回执，私有查询另行授权 |
| D6 调度 | 无后台调度；技术网络 timeout 可保留有界实现，限速取消不能另启动工作回合 |
| D7 结果 UI | 保留既有活动 / 失败反馈；结果类型明确 partial / empty / failed，DOI 对应真实记录；不引入论文工作台 |
| D8 生命周期 | 替换 `requestOnce` 的仅监听 abort 行为：先检查已取消信号并合并 deadline；避免取消后进入 arXiv 的 catch 重试 |
| D9 恢复 | 首轮无持久缓存；重启不补跑查询，旧列表仅是历史候选。卸载保留用户主动保存的产物 |
| D10 许可供应链 | MIT 片段逐文件记录来源和改动，随包告知；首轮避免新增第三方运行依赖，后续仍检查实际制品 |

具体网络缺口：[sources.js 25–67](https://github.com/Cjrrrrrrrr/dsh-plugins/blob/3d546b1dcd534ba412f5eaa7989368e0d5f5e006/packages/dsh-scholar/lib/sources.js#L25)按 chunk 累积无字节上限，监听 abort 前没有已取消检查，重定向未限定允许主机；arXiv catch 重试见同文件 168–178。保留这些代码的成本不能算成“零改造”。去重 267–298 为 DOI / 标题启发式，需覆盖同题不同文与大小写，不宣称语义判重准确。

还要移除隐藏的跨源行为：[getByDoi 329–341](https://github.com/Cjrrrrrrrr/dsh-plugins/blob/3d546b1dcd534ba412f5eaa7989368e0d5f5e006/packages/dsh-scholar/lib/sources.js#L329)会在 Crossref 异常后尝试 OpenAlex，原 `paper_get` 还可调用 Unpaywall。仅把 search 的 sources 改成两项不会满足本评审范围；测试必须断言所有路径只请求获准的两家服务，取消不触发 fallback。

数据链：用户查询 → 获准的两家公共服务；返回元数据 / 摘要 → 当前轮模型与安全展示；用户自主保存的引用清单 → 当前项目。没有 PDF、文件原文、凭据或后台索引进入此链。

## 5. 许可与外部服务

代码复制与修改：MIT 义务待落实。API 使用与内容再分发：独立核对；Crossref 提示部分摘要可能受版权保护，不能把代码 MIT 解释为摘要可任意再分发。[Crossref 数据说明](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)

请求策略按官方限制实现：Crossref 有并发 / 速率限制；arXiv 建议连续请求间隔三秒。源码“免费、无 key”的总说明不能替代实际服务条件；OpenAlex 当前文档区分无 key 基础查询、带 key 额度和 cursor 翻页，本轮不开放它。未申请 key、未消费服务额度。[Crossref 访问规则](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)、[arXiv 手册](https://github.com/arXiv/arxiv-docs/blob/develop/source/help/api/user-manual.md)、[OpenAlex 认证](https://help.openalex.org/api/authentication/)

## 6. 验收计划

| 维度 | 计划与本轮状态 |
| --- | --- |
| E0 | 已审上述范围；结果和未知项如本文，非完整供应链审计 |
| E1 / E2 | 未测；未来校验 LCA 包与 schema，安装 / 启用后只暴露首轮工具，不在 activate 发网络请求 |
| E3 | 未测；固定 12 个合成 fixture：两源正常、重复 DOI、同题不同文、缺摘要、空结果、单源失败、双源失败、429、超大响应、越界 redirect、预取消、中途取消 / 不再重试 |
| E4 | 未测；后续获授权后两源各不超过 2 次公开查询，人工核对标识符；这不等于综述质量评估 |
| E5 | 未测；停用 / 下一轮 / 换项目 / 重启后无旧摘要再入模型或新请求；无后台调度，真实跨日调度不适用 |
| E6 | 未测；发布前验证随包工具、告知文件和安装态正反场景 |

停损条件：实际只需 DOI 查询，或抽取后仍需跟随整仓库 / 多源 provider 配置，则改为小型原生实现；两源质量不足不能靠多装几个源掩盖问题。

## 7. 维护与目录表述

建议维护独立的小型 LCA 包，固定采用片段，按 API 变化复核，不自动追上游 main。停用取消本地等待，卸载不删用户引用清单；没有数据库迁移或授权续跑。维护责任未认领前不发布。

拟用目录文案：“显式检索 Crossref / arXiv 文献元数据并核对标识符；部分组件源自 dsh-scholar。尚未运行验收，不包含全文阅读或自动文献综述。”

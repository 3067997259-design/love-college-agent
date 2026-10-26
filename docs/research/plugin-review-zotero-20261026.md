# 迁入评审：指定 Zotero 文献集合的只读查询

2026-10-26，评审人 Codex；[总评](plugin-migration-selection-20261026.md)，[规格](../plugin-migration-spec.md)。未检查用户是否安装 Zotero，也未读取任何真实文献库。

## 1. 结论卡与证据

| 字段 | 结论 |
| --- | --- |
| 对象 | `Hongcheng-LI/dsh-zotero@0.2.2`；commit `e4042d5139aa81d810b95928d63632f80a32a7ac` |
| 基线 | 总评的 dirty LCA / DSH / Electron / Windows；[证据索引](evidence/plugin-migration-reviews-20261026.json) |
| 范围 | 用户绑定一个本地 library / collection；显式搜索、条目元数据与摘要；首阶段不查询子笔记或附件列表 / 内容 |
| 不保留 | storage 自动探测、全文缓存读写、PDF 解析 / 下载、笔记写入、全库默认扫描、自带 paper-reading skill |
| 路线与影响 | M3 抽 client 与字段映射；F2 新的库 / collection 绑定面；其授权规则涉及 U5，若扩大为默认全库授权另列 F3 |
| 决策 | 先验证，条件式优先级 2；用户没有本地库则后移，不为测试兼容让用户另建库 |
| 证据与许可 | E0 所列源码审查完成，E1–E6 未测；无制品 hash；MIT 采用片段义务待落实，未完成制品清关 |

源码：[package](https://github.com/Hongcheng-LI/dsh-zotero/blob/e4042d5139aa81d810b95928d63632f80a32a7ac/package.json)、[入口](https://github.com/Hongcheng-LI/dsh-zotero/blob/e4042d5139aa81d810b95928d63632f80a32a7ac/src/index.ts)、[client](https://github.com/Hongcheng-LI/dsh-zotero/blob/e4042d5139aa81d810b95928d63632f80a32a7ac/src/zotero-client.ts)、[storage](https://github.com/Hongcheng-LI/dsh-zotero/blob/e4042d5139aa81d810b95928d63632f80a32a7ac/src/storage.ts)、[LICENSE](https://github.com/Hongcheng-LI/dsh-zotero/blob/e4042d5139aa81d810b95928d63632f80a32a7ac/LICENSE)。

## 2. 价值与流程

| 项 | 判断 |
| --- | --- |
| V1 | 条件成立：已有 Zotero 用户查某课程 / 课题 collection，而不用逐篇导出；个人库使用情况未知 |
| V2 | 预期成立：连接真实的文献组织与 item key，比让模型从项目文件猜文献关系更直接；不替代全文阅读 |
| V3 | 窄范围适合：仍在 LCA 对话完成检索与解释，库本身保持 Zotero 管理 |
| V4 | client 较小但现有包混合存储与写操作；新绑定接口和后续维护未认领 |

当前用户需复制条目或另导出文件。目标流程：在连接配置中明确选择 library / collection 与可给模型的字段 → 用户书页发起问题 → main 核对绑定与权限 → DSH 调用受限查询 → 按 key 返回元数据和有界摘要 → 角色给出可回溯列表；不自动打开、下载、修改 Zotero。

本地 API 可读取不等于同意把结果发给模型。独立隐私模式先经过窄处理路径；不能正确处理时停在用户可见状态，不能绕去主模型。来源沿用当前轮授权，旧摘要下一轮退役。Zotero 关闭 / 403 / collection 失效时明确失败，不能回退到扫描磁盘。换项目清除旧绑定的活动权限；没有后台监控、熄灯补扫或自动写入记忆。

## 3. 门槛和成本

| 门槛 | 判断 / 缺口 |
| --- | --- |
| G1 | 方案可保持 U1–U7；关键是把“查库”与“发给模型”拆开 |
| G2 | 缺口：client 使用 timeout 而不接受调用方 signal；原 apply 还会自动 ping，需取消 |
| G3 | 缺口：LCA 无通用外部库绑定接口；`configSchema` 存在不足以证明自动配置页已实现；先做窄配置、安全投影及新工具明确的第三方来源接线 |
| G4 | 根 MIT 支持所选片段的复用路径；告知待落实；文献 / 摘要内容权利不由插件许可证覆盖 |
| G5 | 计划明确，未验证；用户使用前提与维护责任待确认 |

推荐 M3 估算 4–7 人日；同范围原生 client 4–8 人日，区间明显重叠。上游提供了 query 编码、顶层 item 分页、作者 / 日期归一化等经验；如果取消、实例绑定和结果缩减后只剩少量 HTTP 映射，采用 M4 也合理。整包 fork 不划算：它把本轮不要的 PDF、磁盘探测和写库功能变成持续审查负担。暂不做则沿用导出 / 复制资料；低频用户成本可能更低。

## 4. 改造账本和数据边界

| 项 | 迁入处理与证据 |
| --- | --- |
| D1 | 抽离元数据请求和 `slimItem` 等必要映射，重新审 imports；不直接复用会额外读 children 的 `item()`，不随带 `pdfjs-dist`、storage / files 与整个 DSH wrapper |
| D2 | main 固定本机端点和 library / collection，模型不能提交任意 baseUrl；每个 itemKey 检查属于当前集合，不能仅相信模型提供 key |
| D3 | 无嵌套模型。合并调用方取消和请求 deadline，限定 JSON 字节 / 条目 / 字段；隐私处理使用已有受控连接与额度 |
| D4 | 来源身份包含绑定、library、collection、itemKey、版本与读取时间；摘要为第三方来源，元数据也不能获得指令权限 |
| D5 | 不遍历用户 home / profiles.ini，不读取 SQLite / storage / file URL；禁止把 API 返回的绝对路径直接交模型或通用文件工具 |
| D6 | 移除 `apply` 时 ping / 自动 storage 探测；检查连接由显式操作触发，不挂后台同步 |
| D7 | 使用书页活动和引用列表；仅增加窄配置面。全文请求提示当前范围及显式资料导入，不伪装已经读过 PDF |
| D8 | client 全链传 signal；停用、权限变更、项目切换后旧回调丢弃；不自动重连查询 |
| D9 | 连接绑定是本机配置，结果不建全局记忆。重启重新核对实例；旧 item key 不能默认绑定到另一个 Zotero 实例 |
| D10 | 采用片段记 MIT 来源与告知；不带 PDF 依赖 / 第三方素材；升级时复核 API 与实例标识，不直接信版本兼容注释 |

[入口 161–171](https://github.com/Hongcheng-LI/dsh-zotero/blob/e4042d5139aa81d810b95928d63632f80a32a7ac/src/index.ts#L161)会探测 storage 并发起 ping；[client 79–87](https://github.com/Hongcheng-LI/dsh-zotero/blob/e4042d5139aa81d810b95928d63632f80a32a7ac/src/zotero-client.ts#L79)将 signal 设为内部 timeout；同文件 107–147 接收附件重定向路径。它们都是实际改造项，不能用“只暴露两个工具”保证其他行为消失。

同文件 [234–261](https://github.com/Hongcheng-LI/dsh-zotero/blob/e4042d5139aa81d810b95928d63632f80a32a7ac/src/zotero-client.ts#L234)的 `item()` 还会调用 children，并解析子笔记。即使最终不显示笔记，也已经读取过；因此首阶段只查询条目本身，不提供附件列表，避免在“元数据读取”里带入额外私有内容。

数据链：本机 Zotero → main 有界结果 → 按隐私模式允许的模型片段 / 书页安全展示。完整摘要不写普通日志，私有笔记与附件本轮不读。调用外部模型的流量与本地 API 流量分别评价。

## 5. 许可和协议版本

首阶段只复制必要 MIT 代码并保留告知，不分发 Zotero，也不自动下载全文。未来若采用完整包，必须重新审传递依赖与文件功能。

官方文档现已区分无认证读请求、Zotero 10+ 的单独写授权，以及 `Zotero-Server-ID` 实例标识；源码中“本地 API 不支持写”的错误提示不能当作永远成立的安全边界。首阶段必须由 LCA 自己限定 GET 与允许路径，探测实际 API 能力；旧版本无实例 ID 时采用保守的重新绑定策略，不能发明稳定身份。[Zotero 本地 API](https://www.zotero.org/support/dev/web_api/v3/local_api)

## 6. 验收计划

| 维度 | 计划与状态 |
| --- | --- |
| E0 | 本轮所列源码与方案已核对，非整包安全认证 |
| E1 / E2 | 未测；安装后只提供计划中的只读工具，没有启动探测或其他注册副作用 |
| E3 | 未测；合成库正常 / 关闭 / 403、越界 collection 与 item、畸形 JSON、超大摘要、预取消 / 中途取消、隐私失败、实例 ID 改变；断言零文件扫描和零写请求 |
| E4 | 未测；后续明确授权后仅对一个指定 collection 做一次搜索和两项元数据读取，核对 UI 与来源；不读真实附件 |
| E5 | 未测；换项目、停用、重启后旧结果和旧绑定不能自动复用；导出 / 恢复不迁移本机访问授权 |
| E6 | 未测；目标安装态依赖、配置、告知与连接失败反馈验证 |

停损条件：没有现成使用需求，或需要全文 / 复杂研究工作台才能体现价值，则不继续扩大这个样板；重新评选现有 MCP 后端或完整研究需求。

## 7. 维护与目录表述

维护人未认领。建议只跟踪被采用的 client 行为和官方本地 API，升级触发点是实例身份、字段、分页与访问规则变化；停用取消请求，清理本地缓存不碰 Zotero 库。卸载不修改用户条目、笔记或附件。

拟用文案：“读取你明确绑定的 Zotero 文献集合元数据与摘要；不扫描磁盘、不修改文献库、不读取全文。适配来源 Hongcheng-LI/dsh-zotero；尚未运行验收。”

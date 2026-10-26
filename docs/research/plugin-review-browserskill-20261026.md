# 迁入评审：选定真实浏览器标签页的观察

2026-10-26，评审人 Codex；[总评](plugin-migration-selection-20261026.md)，[规格](../plugin-migration-spec.md)。未安装 CLI / 扩展、未启动 daemon、未查看用户浏览器。

同日用户补充 Agent Browser 的低冗余观察偏好后，浏览器候选顺序已调整：先评 Agent Browser，BrowserSkill 保留为可见借页流程的备选，见 [观察成本补评](agent-browser-observation-followup-20261026.md)。本文的成本仅与自建同范围后端比较，不能据此认定优于 Agent Browser。

## 1. 结论卡与证据

| 字段 | 结论 |
| --- | --- |
| 对象 | `Tencent/BrowserSkill`，commit `c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b`；DSH 包 `@wxg-prc-cpg/browser-skill-dsh-plugin@0.3.3` |
| 基线 | 总评的 LCA / DSH / Windows；当前包未安装，CLI、daemon、浏览器扩展实际版本均未核验，无制品 hash |
| 第一阶段 | 用户选定浏览器实例和一个标签页，授权借入 Agent Window，读取有界正文与控件结构，然后归还；只支持文本观察 |
| 排除 | 通用 click / type、表单提交、上传下载、任意 JS、调试 network / console、录屏、自动截图轮询、远程 relay、其他用户标签页正文 |
| 路线与等级 | M1 保留独立执行后端，M3 复用少量 runner / 会话核对；F2 对象选择与借还流程；扩大到操作授权须重新判 F3 |
| 决策 | 保留候选；浏览器能力仍可按需求提高优先级，具体后端先补评 Agent Browser，不默认选择 BrowserSkill |
| 证据 / 许可 | E0 所列源码审查完成，E1–E6 未测；插件与根 MIT，实际 CLI / 扩展制品和依赖义务未清关 |

来源：[包](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/packages/dsh-plugin-browserskill/package.json)、[入口](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/packages/dsh-plugin-browserskill/src/index.ts)、[runner](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/packages/dsh-plugin-browserskill/src/runner.ts)、[会话 registry](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/packages/dsh-plugin-browserskill/src/sessions.ts)、[启动核对](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/packages/dsh-plugin-browserskill/src/session-starts.ts)、[借还工具](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/packages/dsh-plugin-browserskill/src/phase-one-tools-tabs.ts)。文件 hash 见 [证据](evidence/plugin-migration-reviews-20261026.json)。

## 2. 价值与流程

| 项 | 判断 |
| --- | --- |
| V1 | 成立于“帮我理解当前已登录网站的这一页 / 表格 / 错误”；实际使用频率待确认。校园批量扫描仍优先既有校园后端 |
| V2 | 预期成立：web_fetch 不能代表用户当前登录页面与交互状态；已有专用连接器可完成的任务不必改走浏览器 |
| V3 | 有条件成立：用户在 LCA 发起，浏览器是外部工作对象，不成为第二个主聊天工作台；借走标签页本身须明确可见 |
| V4 | 后端已有会话管理、队列、取消和停止核对实现；依赖 CLI / 扩展 / 浏览器版本，适配和维护责任未认领 |

流程：用户在书页指定当前页面 → main 提供安全的浏览器 / 标签页选择并确认授权 → 在指定实例建立归属会话 → 借入目标 tab，保留目标软件自己的确认机制 → 读取一次有界文本 / 控件观察 → DSH 依据来源回答 → 归还标签页，书页显示归还已核实或待核对。只读内容仍可能是敏感数据，发送给模型需按隐私模式决定。

`tabs.borrow` 会把真实用户标签页移入 Agent Window，并非无可见副作用的后台读取；[工具定义 278–323](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/packages/dsh-plugin-browserskill/src/phase-one-tools-tabs.ts#L278)返回原窗口与位置供归还。用户拒绝或没有可借标签页时不自动接管其他页面。专注时不自发借页或抢焦点；停止、熄灯、换项目中止继续观察并核对清理，不能把停止 CLI 等同于页面已归还。

## 3. 门槛与等范围成本

| 门槛 | 判断 / 缺口 |
| --- | --- |
| G1 | 保留 DSH agent 循环和 LCA 主流程可行；浏览器执行队列不是另一个 agent，不能因此一概拒绝 |
| G2 | 有较强复用依据，但 plugin-owned 会话不自动等于 LCA 当前项目 / 成员有权操作；每次命令都要重新核对绑定 |
| G3 | 需要有限对象授权与结果投影；原 DSH Web UI 可选，不能因为没有 Web UI 就断言后端不可用，也不能直接把全工具组挂上 |
| G4 | 采用 MIT 代码路径可行，LICENSE / 依赖 / 制品待核对；使用个人登录态不是插件许可证授予的访问许可 |
| G5 | 生命周期设计有参考，未在 LCA 运行；安装依赖、真实借还和维护人仍待验证 |

推荐 M1 + M3 为 6–10 人日：保留上游 CLI / daemon / extension，LCA 自写有限工具与状态，复用经审的进程收尾 / 启动核对逻辑。同等范围自建后端估 15–25 人日，需承担浏览器连接、页面观察、目标归属、借还和恢复；区间是经验拆分，不是实测性能或工期。

不推荐维护完整 DSH 包 fork：它还注册渐进 skill、agent-scoped skill、观察 HTTP、归档清理和整组工具，而 LCA 只需要其中一段。若仅需公开网页，则暂不做并沿用 web_fetch；若只需新建临时无登录浏览器，则轻量 CDP 后端值得重新比较，不能把 BrowserSkill 固定成唯一答案。

## 4. 改造账本

| 项 | 处理与验收 |
| --- | --- |
| D1 | CLI、daemon、extension 是独立依赖，固定匹配版本与可信来源；LCA 使用明确的二进制绑定，不盲信默认 PATH 的 `bsk`；不自动运行上游安装指南 |
| D2 | 只开放创建 / 核对本次会话、借 / 还选定 tab、正文 / 控件观察的有限操作；模型不能传任意 CLI 参数、任意 tabId 或任意脚本 |
| D3 | 观察本身无新模型 provider；文本解释走当前 DSH 路由 / 额度。限制观察字节和调用次数，不启用持续轮询、录屏或下载 |
| D4 | 页面文本、DOM 标签及控件名均为第三方内容，当前轮投影后退役；返回文本中的指令不能扩大工具范围 |
| D5 | 绑定浏览器实例 / profile / session requestId / tab 身份与当前 LCA 作用域；不把整个用户标签页清单送模型，不读取 cookie / network / console |
| D6 | 不采用原观察轮询；只按用户任务调用。保留必要技术 deadline，业务启动 / 熄灯 / 重启规则归 main |
| D7 | LCA 新建有限对象选择与“正在借用 / 归还待核对”状态，保留浏览器可见控制提示；不迁入 DSH 侧栏和原 Web server 路由 |
| D8 | 复用 runner / queue 的取消经验；确认取消后 daemon 命令是否仍在执行。停用与卸载只清理本插件拥有的资源，不全局关闭浏览器或共享 daemon |
| D9 | 本机保存最小 operation / requestId / 归还状态，不持久存页面正文。冷启动只 reconcile 自己的未知资源，不自动恢复业务、重借 tab 或重放批准 |
| D10 | MIT 采用文件告知；发布前审实际 CLI / 扩展制品、依赖及升级行为；扩展商店可安装不等于 LCA 已兼容 |

上游 [index.ts 78–159](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/packages/dsh-plugin-browserskill/src/index.ts#L78)默认启用 observation / lazyTools、恢复 start journal 并注册 skill；webServer 用可选注入。必须逐项裁剪，不能只改工具名称。`SessionRegistry` 按插件归属限制资源；LCA 还需当前用户 / 角色 / 项目 / 授权家族这一层。

数据链：用户选择的页面 → BrowserSkill → main 有界第三方结果 → 获授权模型片段；日志记录操作与结果状态。模型回答不证明某页全部可见，需保留截断 / coverage 提示。第一阶段没有图像数据，避免把现有 `work-frame` 字段或 Minecraft 截图窄出口误当通用截图 API。

新增最小契约：对象绑定 ID、允许操作集合、项目 / 回合 / 家族、撤销 epoch、持久 requestId 与清理状态；main 决定有效性，renderer 只见安全标签和有限命令。这是待实现的接口，不是当前已存在的授权对象。

## 5. 许可与供应链

根与 DSH 包 [MIT LICENSE](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/packages/dsh-plugin-browserskill/LICENSE)已核对。首选让用户单独配置受支持的后端版本，LCA 分发自己的适配层和实际复用片段；这减少打包工作，但不免除复用代码和目标分发方案的许可检查。若随 LCA 分发 CLI / 扩展，必须补实际制品、全部依赖和告知清单。

README 说明本地方案需要 CLI、daemon 和浏览器扩展；它们均未安装或启动。[官方安装组成说明](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/README.zh-CN.md#L45)

## 6. 验收计划

| 维度 | 计划与状态 |
| --- | --- |
| E0 | 已审列明边界与关键模块；非后端全量安全审计 |
| E1 / E2 | 未测；确认适配制品只暴露有限操作，匹配 CLI / extension，启用不自动创建浏览器工作会话 |
| E3 | 未测；fake runner / daemon 下测试外国 session、错误 profile、tab 身份改变、过期许可、超限正文、预取消、start 回执丢失、return 回执丢失、迟到回调及共享 daemon 不被全局终止 |
| E4 | 未测；后续授权后使用合成网页和专用测试 profile 验证真实借页 → 观察 → 归还；再单独授权一个真实页面，不读整份历史或其他页面 |
| E5 | 未测；熄灯 / 换项目 / 停用 / 重启只核对自己的 session；明确无法归还的状态，不自动重演页面操作 |
| E6 | 未测；安装态无系统 PATH 假设，依赖不存在 / 版本不匹配有反馈；告知与升级核对 |

停损：如果 backend 无法限定目标或无法核对未知借还状态，停止本路线，不通过暴露完整 CLI 来兜底。没有实际网页任务需求则保持 web_fetch / 专用连接器，不建设通用浏览器平台。

## 7. 维护与目录表述

维护人未认领。CLI / 扩展协议、浏览器版本、会话恢复行为变化均触发相关验收；旧版通过不能给新版背书。停用后完成必要清理或保留 unknown；卸载不删除用户 profile、cookie 或下载文件。恢复私人存档不恢复软件访问许可。

拟用文案：“借用你选定的浏览器标签页，读取本次任务需要的正文与控件信息；使用 BrowserSkill 后端。第一阶段不提交表单或修改页面；尚未运行验收。”

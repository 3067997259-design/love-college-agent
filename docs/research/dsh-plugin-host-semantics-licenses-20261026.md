# DSH 插件接入：宿主职责、逐项目评估与许可

2026-10-26，接续 [Coopanion 与入口检查](dsh-plugin-compatibility-coopanion-20261026.md)。用户明确指出：LCA 只在 harness 执行层继承 DSH，产品已有自己的精密编排；共享 Cordis 扩展机制不能推出插件可按固定规则转换。本文据此收窄上一轮建议，并补查代表项目与许可。

**研究对象应是“某个插件的某项能力，能以什么集成方式进入 LCA”，而不只是“这个包能否加载”。** 包装规则、服务契约检查可以自动化；接管哪些行为、哪些行为必须保留在 LCA、适配是否值得、能否按目标形式分发，需要逐项目判断。原样安装、裁剪后的适配版本、复用独立组件和只参考设计，必须分别记录。

## 证据矩阵

从用户提供的 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/tree/a7ae7b2a1295e96b2a84268ed0443f1aead14f33) 固定目录中新增五个有目的选取的样本：视觉、上下文面板、工作台、定时编排、项目记忆。前轮的 `dsh-find-plugin` 继续作为较窄工具样本。本次选择覆盖不同宿主职责，不是随机抽样或完整生态统计；较小项目用于暴露职责冲突，不声称都是“经典项目”。

| 样本 / 固定版本 | 源码确认的接入方式 | 对 LCA 的判断（尚未运行） | 根许可 |
| --- | --- | --- | --- |
| [ModLens 3.27.2](https://github.com/liustack/modlens/tree/ac278f885386f785dc1a35ddfbd8994bb5e744d7) | 工具、附件、agent 与 llm 注入；默认注册视觉 provider 包装；子进程调用识图引擎 | 可评估独立识图能力；模型连接、原文外发、回退和预算必须逐项接回 LCA | MIT |
| [dsh-context 0.77.0](https://github.com/bowenliang123/dsh-context/tree/aae7f62080a8c63379a1eaddc8a577349a6f4a1f) | session projection、内容详情 API、DSH Web client；另有可配置 system prompt 前后缀 | 统计逻辑可能可复用；原始内容查看与提示词编辑不能因“诊断面板”名称自动获准 | Apache-2.0 |
| [DSH-better-sidebar 0.28.0](https://github.com/omdsh-dev/DSH-better-sidebar/tree/83faf70940160e5cd4c5332f5400aa8f4dbbb6d6) | DSH 客户端工作台、宿主文件路由、Git 与协作入口；文件路由明确不限制在工作区内 | 按现有职责边界不推荐整包接入；局部组件是否值得复用需单独评估 | MIT |
| [dsh-cron 0.3.20](https://github.com/GooDAnDReaDY/dsh-cron/tree/c0b19d917b6921ed890166cf48eadda26b93b8d4) | 自有 TaskScheduler、原生定时器、SessionRunner、创建 agent；强制依赖 webServer / credentials 等服务 | 第二套调度与执行入口，不宜为兼容整包而迁就；表达式解析或任务编辑可另评 | MIT |
| [dsh-project-memory 0.6.5](https://github.com/00080000/dsh-project-memory/tree/f5aa9dcfd815edf4256e619648e9455889b316a7) | `fs/observed` 自动索引、持久项目 / 任务记忆、`agent/pre-step` 注入、后台 watch | 可研究独立项目检索；不能直接等同 LCA 的角色记忆，也不能自动获得跨回合原文授权 | MIT |

本轮只做源代码、manifest、patch 和根 LICENSE 对照，未安装、未启动插件、未调用模型或外部识图服务。上述判断是结合 LCA 契约的设计判断，不是运行通过 / 绕过守卫的证据。固定 revision、所读文件 blob SHA 和证据范围见 [样本记录](evidence/dsh-plugin-semantic-samples-20261026.json)。

## 1. 共享的执行机制不决定产品行为

LCA 的 [技术方案](../tech-design.md)明确把权限、连接、持久化和安全投影放在主进程，业务时钟与后台调度由统一 Clock / Scheduler 管理。DSH 负责 agent 回合内的模型步骤、工具调用、重试、取消及已接入的协作执行；LCA 为这些回合绑定用户、角色、项目、授权和预算，并决定资料进入 / 退出上下文的时机。不是另写一套 agent 循环，也不是把整套 DSH Desktop 搬进书页。

因此需要检查插件的具体写入点与副作用，而不按“工具插件 / UI 插件”名称推导整包兼容：

- **ModLens：** [入口](https://github.com/liustack/modlens/blob/ac278f885386f785dc1a35ddfbd8994bb5e744d7/dsh/index.js)在 `visionProvider !== false` 时注册 provider 包装；`autoRead` 则只有显式 true 才启用，不能混为一个默认行为。其识图引擎有独立模型来源与回退策略。LCA 若采用，必须具体决定哪份图像获授权、由哪条连接处理、如何记账与取消，不能因调用起点是 DSH tool 就视为已经覆盖这些语义。
- **dsh-context：** [promptInjection.ts](https://github.com/bowenliang123/dsh-context/blob/aae7f62080a8c63379a1eaddc8a577349a6f4a1f/src/host/promptInjection.ts)注册全局前后缀；空白配置不产生正文。这不是强制覆盖 persona，但说明它并非只有只读统计。[detail.ts](https://github.com/bowenliang123/dsh-context/blob/aae7f62080a8c63379a1eaddc8a577349a6f4a1f/src/host/detail.ts)还访问 session 内容。裁成只读聚合面板、保留原始内容查看、保留提示词编辑，是三种不同范围。
- **DSH-better-sidebar：** [path-security.ts](https://github.com/omdsh-dev/DSH-better-sidebar/blob/83faf70940160e5cd4c5332f5400aa8f4dbbb6d6/src/path-security.ts)明确将原工作区边界检查改为路径解析，能力范围按宿主用户的 OS 权限计算。那是它的产品选择；与 LCA 的项目权限、私有数据保护和受限 renderer 不同。仅换 UI 或重命名行 ID 无法解决。
- **dsh-cron：** [scheduler.js](https://github.com/GooDAnDReaDY/dsh-cron/blob/c0b19d917b6921ed890166cf48eadda26b93b8d4/lib/scheduler.js)自行维持定时与运行任务，[runner.js](https://github.com/GooDAnDReaDY/dsh-cron/blob/c0b19d917b6921ed890166cf48eadda26b93b8d4/lib/runner.js)调用 `ctx.agents.create`，还可设置 permission preset。即使 API 版本吻合，也尚未证明会正确服从熄灯、番茄阶段、额度、授权家族和恢复规则。现有 LCA 守卫可能拒绝这类新会话，不能把“放松守卫使其能跑”当作兼容修复。
- **dsh-project-memory：** [lazy.js](https://github.com/00080000/dsh-project-memory/blob/f5aa9dcfd815edf4256e619648e9455889b316a7/src/lazy.js)从文件观察事件索引，[auto-inject.js](https://github.com/00080000/dsh-project-memory/blob/f5aa9dcfd815edf4256e619648e9455889b316a7/src/auto-inject.js)在步骤前追加召回内容。项目索引不必等于角色经历，可以另设作用域；但自动索引不等于成功模型输入的允许片段，其 provenance 标记也不自动等于 LCA 的来源退役规则。是否保留自动回填、watch、全局晋升，必须逐项设计。

这些例子说明了评估表的用途：提出有证据的问题，而不是生成一个通用转换器。一个插件即使全部接口可实现，也可能因维护成本、产品重叠或用户体验而不值得整包支持。

## 2. “兼容多少”怎样才可解释

固定目标必须包含：LCA 源码 / dirty 状态、DSH 版本、OS / Electron、插件精确制品与配置。统计单位是具体发布制品及其功能范围；仓库数、目录条目数和 npm 包数不能混用。同一仓库可含多个插件，也可能只是另一款应用。

每个样本同时记录三组结果，不把它们压成一个布尔值：

| 维度 | 需要报告的内容 |
| --- | --- |
| 工程证据 | 未测、包装拒绝、安装结果、服务激活、功能回执、停止 / 重启 / 恢复；每一项分别标记 |
| 产品适配判断 | 原样接入候选、需指定适配、仅复用某组件、仅参考设计、不推荐接入；写清 LCA 保留的职责及功能损失 |
| 使用与分发许可 | 哪些代码 / 资产 / 依赖、什么版本、直接安装 / 修改 / 随包分发 / 提供服务；已核对和待核对的义务 |

如需给数量，应先建立一个固定的 N 项样本集，完整保留成功、失败、未测和不适合接入的项目；报告“其中 x 项在指定 LCA 版本原样通过完整场景，y 项以明确适配版本通过，z 项仍未运行”等，并另外报告产品适合性与许可。不能把 adapter 版本计成原包原样兼容，不能把只抽出来的一个组件计成整个插件兼容，也不能删去职责冲突样本让比例更好看。

本轮新增五项是针对性源代码研究，运行验收均为 **not-run**。前轮 7 项入口刻画与 11 项合成包回归的数量仍保持原义，不能累加成已兼容第三方插件数。也不从这批样本估计全市场比例。

## 3. 许可是独立的接入条件

目前 LCA 根项目为 MIT。目录的 [CC0-1.0](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/a7ae7b2a1295e96b2a84268ed0443f1aead14f33/LICENSE)只描述目录自身的许可，不能覆盖它链接到的各项目。

本轮五个样本逐一核对了固定提交的根 LICENSE 和 `package.json`：ModLens、sidebar、cron、project-memory 为 MIT，dsh-context 为 Apache-2.0。根许可相对宽松也只解决一部分问题；还没有完整检查传递依赖、所有图标 / 截图 / 模型资源或发布包内容。样本记录因此没有给出分发清关结论。

| 拟采取的动作 | 需要核对的许可范围 |
| --- | --- |
| 收录介绍与链接 | 目录元数据、介绍文字与图片各自的来源；收录不等于获得再分发插件的许可 |
| 用户自行安装原包 | 插件原条款、安装来源及呈现的许可；不能把许可标签写成已经完成 LCA 兼容验证 |
| 修改源码 / 做适配 fork | 原许可证、版权 / 许可告知、修改说明、适配部分与原代码的许可关系 |
| 把插件或组件打进 LCA 安装包 | 随包依赖与资产清单、需要随附的 LICENSE / NOTICE、适用的源码提供或其他分发义务 |
| 部署远程服务 | 结合具体许可证和是否修改 / 组合判断网络使用义务，不能套用本地安装结论 |

MIT 要保留适用的版权与许可告知。Apache-2.0 的第 4 节要求随附许可证、标明修改，并按适用情况保留告知及 NOTICE 内容；不能只在总表写一个 SPDX 就算完成。[Apache 原文](https://www.apache.org/licenses/LICENSE-2.0.txt)

Coopanion 的[实际 LICENSE](https://github.com/Pal-AI-Lab/Coopanion/blob/544302aa3f6861a587b1bc64668e744164ce6d15/LICENSE)是 AGPL-3.0-or-later，额外许可针对 Steamworks 库，不是对任意宿主的通用链接豁免。AGPL 并不等于“不能用”，也不等于原样放进 MIT 发布包而无需进一步处理；修改、组合、分发和网络交互分别需要对照条款。AGPL 第 13 节涉及修改版本与远程交互时的对应源码提供。不能只因称作插件、单独子进程或 IPC 就宣布许可隔离成立；FSF 的[插件说明](https://www.gnu.org/licenses/gpl-faq.en.html#GPLPlugins)也将通信方式和语义纳入判断。这是需要按具体集成方案核对的许可问题，本文没有作出某个未来组合一定适用何种许可的法律结论。

未提供明确许可或存在矛盾的制品，标为“复用 / 分发授权未明确”，不从公开可读推导可复制分发；GitHub 的[无许可说明](https://choosealicense.com/no-permission/)也区分了公开查看与复用授权。代码许可不替代美术 / 商标 / 模型权重的许可，素材采用仍遵守 LCA 的用户批准流程。

## 4. 对下一步的修正

1. 先逐项目确定有用的能力和接入范围，保留 LCA 已有的工作编排、角色连续性、授权与数据边界。
2. 对有价值且许可路径可行的候选，才决定原样试装、维护适配版本、复用组件或自主实现。
3. 若明确选择了原生 bundle 候选，再处理前轮发现的行 ID 准入限制，并保留安全行、冲突与恢复检查。这个限制是真实发现，但不因此成为全产品必须优先放宽的阻塞。
4. market 可以先保存上述逐项目评估与证据；展示“原样可用”“适配版本”“参考项目”等不同结果，不承诺一键把所有 DSH 插件转成 LCA 插件。

本轮新增研究记录、样本证据，并修订前轮建议。没有修改生产策略或 API，也没有添加新的插件转换实现；纯文档与 JSON 做链接、结构及内容核对，未重复运行前轮生命周期测试。

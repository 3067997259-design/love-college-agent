# Coopanion、DSH 插件兼容范围与市场准入

2026-10-26。研究结论与兼容性刻画，不是安装说明或已决定的 market 方案。LCA 基线为 `711af30d0299141d5830d78b51090dd195f9cb31` 的未提交开发工作区，DSH 固定 `0.2.1-rc.2`。本轮仅新增研究、探针与证据，没有修改生产扩展策略，也没有安装这些第三方插件。

同日补充：[宿主职责、逐项目评估与许可](dsh-plugin-host-semantics-licenses-20261026.md)。用户明确要求保留 LCA 自身的精密工作编排；共享 Cordis 不能推出固定规则可转换所有插件。本篇入口反例仍成立，但不把放宽准入直接提升为产品优先项，后续顺序按补充研究收窄。

## 证据矩阵

| 问题 | 本轮证据 | 结论与边界 |
| --- | --- | --- |
| Coopanion 是可直接安装的 DSH bundle 吗？ | 固定提交的应用 / World manifests、入口源码；生产候选选择代码处理元数据副本 | 否。应用是 Cortico 桌面宿主，桌宠包是 `cortico.kind=world` / `api=6`，两者均无 `dsh.bundle` |
| 经典 DSH 工具包能原样通过 LCA 入口吗？ | `dsh-find-plugin@0.4.0` 原始 manifest / patch；生产 patch 校验 | 此样本不能。其行 ID `find-dsh-plugin` 不符合 LCA 的 `包名:` 前缀规则 |
| DSH 的市场 UI 能直接给 LCA 用吗？ | `dshmarket@1.11.3` 的 desktop fork；manifest、host 入口、patch | 原始行 ID 同样被拒绝；另依赖 DSH Web 服务和 client 注入，LCA 书页没有对应客户端宿主 |
| 是否只是行 ID 阻塞？ | 两个样本仅在临时元数据中替换为 namespaced insert，再交生产校验 | 均到达假安装器边界；假安装器故意失败。只定位了首个门槛，未验证依赖、加载、执行或 UI |
| LCA 的 DSH 生命周期底座仍有效吗？ | 本轮实际运行既有 `dsh-extension-check.mjs --electron` | 11 项合成包场景通过，19 次合成审批，零模型请求；不是第三方插件验收 |
| 第三方新工具是否自动接入来源策略？ | 当前 `policy.js`、family 的调用路径与纯函数观察 | `find_dsh_plugin` 未被识别为外部来源，不能仅凭可调用就标为完整兼容 |
| 换底座是否已经证明通用兼容提升？ | 现在实际具备 DSH profile / Cordis 服务 / 工具注册 / 包管理与生命周期 | 能确认复用基础存在；没有旧底座与新底座的同样本成对实验，不能给兼容率或因果量化结论 |

样本元数据与来源见 [固定快照](evidence/dsh-plugin-samples-20261026.json)，生产入口刻画见 [7 项检查与策略观察](evidence/dsh-plugin-compatibility-20261026.json)，生命周期见 [11 项本轮回执](evidence/dsh-extension-baseline-20261026.json)。测试断言通过包含“如预期拒绝”，不能将其写成插件运行通过。

## 1. 先分清宿主与扩展契约

[Coopanion 主线 `544302aa`](https://github.com/Pal-AI-Lab/Coopanion/tree/544302aa3f6861a587b1bc64668e744164ce6d15) 的应用版本是 `0.2.10`，由 Cortico Core、Cormini Persona、桌宠 World 与自己的 Electron 壳组成。它锁定的 Cortico 子模块是 `cb9ddbd685bcccba1f29905098648f46a79b3862`。

这不是本次发现的一次“DSH 改名”：所检查的[初始应用 manifest](https://github.com/Pal-AI-Lab/Coopanion/blob/07a51315a7aef7df6232a5805bf0fd6c094d57bc/package.json)也声明 Cortico。当前源码未提供 DSH bundle 入口，不能因为它是 agent 桌宠或被生态目录收录就归为 DSH 原生插件。

| 层次 | Coopanion / Cortico | 当前 LCA / DSH |
| --- | --- | --- |
| 安装契约 | npm 包的 `cortico.kind`、`cortico.api` | 本地包的 `dsh.bundle.patch`，再经过 LCA 守卫 |
| 扩展入口 | `WorldDefinition.create(ctx)` → World 实例 | Cordis 插件 `apply(ctx)`、服务注入与 patch 组合 |
| 能力边界 | 工具、事件、环境描述、生命周期、输出流 | DSH 工具与 agent/session 服务；LCA 持有调度、批准与安全投影 |
| 界面 | World 自有 WebUI / 窗口，加 Coopanion 产品壳 | LCA React 书页与受限 preload，没有通用 DSH Web client 插槽 |
| 人格与记忆 | Persona / Memory 是 Cortico 的宿主契约 | LCA 自己的角色、记忆、数据根和上下文规则 |

来源：[桌宠 manifest](https://github.com/Pal-AI-Lab/Coopanion/blob/544302aa3f6861a587b1bc64668e744164ce6d15/packages/cortico-world-desktop-pet/package.json)、[World 定义](https://github.com/Pal-AI-Lab/Coopanion/blob/544302aa3f6861a587b1bc64668e744164ce6d15/packages/cortico-world-desktop-pet/src/definition.ts)、[应用开发说明](https://github.com/Pal-AI-Lab/Coopanion/blob/544302aa3f6861a587b1bc64668e744164ce6d15/docs/DEVELOPMENT.md)；LCA 的 [profile](../../dsh/lca-bridge/profile.js)、[bundle](../../dsh/lca-bridge/cordis.patch.yml)、[扩展入口](../../src/main/dsh/extensions.ts)。

## 2. 哪些能照用，哪些需要适配

这里的“可复用”指不必重写业务逻辑的可能范围，不是尚未完成的运行验收。

| 类型 | 可以保留的部分 | 接入 LCA 需要核对的部分 | 当前判断 |
| --- | --- | --- | --- |
| 原生 DSH 工具 / 无 UI 服务插件 | 兼容版本的 Cordis 注入、工具声明和业务实现 | bundle 行、peer 版本、宿主服务身份、工具来源、权限与取消 | 最适合首批，但不能按包名一概原样放行 |
| DSH agent/session hook 插件 | 对相同 DSH 服务契约的 hook | 是否改模型路由、上下文、persona、记忆、后台调用；是否经过每步额度准入 | 逐能力审查，尤其不能覆盖 LCA 的安全层 |
| DSH Web / Desktop UI 插件 | 数据与业务后端可能可拆出 | client 注入、页面路由、webServer、特定 Desktop 服务 | 现有书页不能直接显示，需 LCA 界面适配 |
| Cortico 纯工具 World | 参数、业务逻辑、工具结果与环境模板可能复用 | WorldHost / WorldContext、配置、秘密存取、附件与 start/stop 的适配 | 尚无适配器，当前不能安装 |
| Cortico 事件 / 实时 World | 环境实现与部分工具 | 事件持久化、唤醒、抢占、中断、输出外化、后台认知 | 属跨框架接入，不能靠包装 manifest 完成 |
| MCP / Markdown skill | 各自的协议或文件格式 | LCA 现有连接、项目范围、来源和批准链 | 走已有入口，不伪装成 DSH bundle |
| 完整桌宠应用、人格 / 记忆替换包、形象包 | 思路、协议设计或经许可的独立组件 | 独立产品生命周期、角色与数据归属、资源格式及素材批准 | 不能整包照装，也不自动采用其角色素材 |

### 经典样本：dsh-find-plugin

固定来源：[提交 `afce1cd4`](https://github.com/awesome-dsh-plugin/dsh-find-plugin/tree/afce1cd43f98b8a8b02e4a35cd6a65d6444de412)。它通过 `ctx.tools.register(defineTool(...))` 注册 `find_dsh_plugin`，只强制注入 `tools`，凭据服务缺失时可降级。这类插件最接近“共享底座后业务实现不改”。

实际有三道独立门槛：

1. **本地准入规则。** 原始 patch 的 `id: find-dsh-plugin` 合乎其 DSH 包装，但不满足 LCA 的 `dsh-find-plugin:` 前缀规则，因此得到 `protected`。这不是“上游包恶意”或“DSH 不支持”的证据。
2. **版本声明。** `dsh-tools` 的 peer 范围止于若干 `0.1.x` 范围，本轮 semver 对 `0.2.1-rc.2` 判 false。说明作者没有声明本版本支持，不能据此断言实际 API 必坏；也不能盲改范围后就授予兼容徽标。
3. **产品语义。** 工具主动搜索 GitHub，并返回外部说明和安装命令。LCA 的 `sourceOf('find_dsh_plugin')` 当前是 null，`gatedWhileDegraded(...)` 是 false。原生 DSH 插件不经过 `registerLcaTools` 的来源元数据注册路径，因此不能假定它自动获得网页工具相同的第三方来源追踪与退役。插件返回的安装命令也只应是待审建议，不能直接运行。

第三点是纯函数与调用路径证据，没有在真实回合中演示绕过。它不代表所有 DSH 批准或沙箱检查都失效。经批准的插件本身是宿主代码，`execute()` 之外的网络、文件和子进程行为也不因 LCA 工具守卫而自动受限。

### UI 样本：dshmarket 的 desktop fork

固定来源：[提交 `188d3a6a`](https://github.com/KokuYu-sysu/dsh-market-desktop/tree/188d3a6a756a45bbaaa773e91cd7802c59a7a26f)，这是所选 fork 的样本，不代表所有市场实现。其 patch 使用 `id: dsh-market`，同样被 LCA 前缀规则拒绝。

即使解决行 ID，其 `dsh.client` 仍要求 connection/runtime/locale/settings/theme，host 入口等待 `webServer` 与 `loader`，Desktop 分支还使用 `desktopProfiles` / `desktopPnpm`。这些是另一种客户端宿主契约。LCA 的准备脚本还裁掉了自身不使用的 DSH UI 包。把市场包装上不会让它自然出现在书页，也不应另开一个可以绕过 LCA `operationId` / 批准的安装入口。

其 `dsh-settings` peer 范围也未包含当前运行时，但声明为 optional；这与强制依赖加载失败不同，不能直接据此声称包管理器一定拒绝安装。

### Coopanion 为什么是有用的边界样本

桌宠 World 的实现使用 `host.store`、`pushEvent`、`modelFacts`、`blob`、事件撤回 / 提级，以及 `outputTap()`、`onRunPhase()`；还管理本地服务、窗口、语音和电脑操作。因此工具函数搬过去只能覆盖一部分体验。

Cortico 自己的[兼容等级说明](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/docs/world-compatibility.md)分为工具、事件流、投递语义、实时能力四级。根据[桌宠源码](https://github.com/Pal-AI-Lab/Coopanion/blob/544302aa3f6861a587b1bc64668e744164ce6d15/packages/cortico-world-desktop-pet/src/world.ts)，完整复用会涉及第三级及第四级的多项能力；这是本轮对接口使用的推断，不是上游为桌宠给出的正式最低等级。

LCA 尚无 WorldHost 适配器，不能说现在已达到某级。后续若实验，先选不依赖事件的纯工具 World，并明确支持的成员；桌宠只作后续压力样本。事件唤醒必须接 LCA 的时钟、预算、熄灯、专注节奏及来源策略，不能为实现 World 的行为再偷偷启动一个独立模型循环。

## 3. 对我们自己的 market 的建议

**先建立可验证的兼容目录，再扩展安装来源。** 这是建议顺序，尚未确认为新的产品路线。

每条记录至少分清三件事：插件作者声明什么、本次静态检查发现什么、哪个环境实际验证过什么。包存在、官方 / 热门标签、安装成功和能力可用不能共用一个“已兼容”状态。

建议记录：

- **制品身份：** 仓库、精确提交 / npm 版本、包内路径、摘要与许可证；应用、原生 DSH bundle、Cortico World、MCP、skill、形象资源分开。
- **宿主需求：** DSH 与 LCA 版本、Node / Electron、平台、服务注入、client surface、原生模块、构建脚本、外部程序与凭据。
- **能力与边界：** 工具 / 事件 / UI、读写与网络行为、模型与预算、来源标记、可取消性、需要 LCA 独占的 persona / memory / scheduler 权限。
- **分阶段结果：** 包装预检 → 隔离安装 → 实际激活 → 功能回执 → 权限 / 来源 / 取消 / 重启；每项保存 pass / fail / unknown / not-run、原始失败和适配差异。
- **新鲜性：** 验证日期、LCA 源码 / 运行时 / 制品哈希、dirty 状态。换版本后结果不自动继承；作者声明和实测徽标分开。

Cortico 的[扩展设计](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/docs/extensions.md)有几个值得借鉴的机制：按 kind 维护契约版本，市场只读预生成能力描述，官方索引与包元数据分开，索引失败显示过期状态，区分磁盘版本与实际加载版本。其安装策略是另一个产品的选择，不能一起照搬到 LCA。

以下是候选项目评估时需要检查的事项，不是已确定的通用转换规则或实施优先级：

1. **给拒绝原因分类。** 无 bundle、受保护行、ID 冲突、未验证 peer、缺服务、缺客户端 surface 应分别说明，避免用户只得到 `failed` 或笼统 `permission-denied`。
2. **在确定接入范围后评估 bundle 准入。** 现有前缀规则会挡住正常生态包，但先要确定这个包是否适合 LCA、其行为应由谁拥有，以及许可路径。确定候选后才评估新增 ID 冲突与核心行保护，或审查具体包装层。不要简单删除守卫，也不要盲改所有 ID：其他 patch 可能引用它们。本轮的行替换仅用于定位问题。
3. **建立插件能力与来源登记。** 新工具不能依赖手写名称表猜语义；登记结果要覆盖调用前权限、返回来源、上下文退役、重启恢复以及成员继承。声明本身不是执行隔离，需要代码审查与实际行为验证。
4. **为职责与许可已厘清的候选设计具体场景。** 需要原样接入的包才进入完整安装验证；维护 adapter 或只复用独立组件要另记身份与功能范围。固定制品，验证实际产物、取消、停用、重启和来源退役；不得为了过测自动降级 / 升级运行时或豁免版本。
5. **界面与跨框架适配单列。** DSH UI 插件的后端复用、Cortico World 工具接入分别做小范围实验，不与首批原生 bundle 宣称同等支持。

当前源码的许可字段：Coopanion 应用与桌宠包为 `AGPL-3.0-or-later`；Cortico 框架为 MIT；两个 DSH 对照样本为 MIT。Coopanion 的美术还有单独来源说明。这里仅记录来源事实，不将框架的许可推定给应用或美术；本轮没有复制运行代码或采用素材。

## 4. 复现与验证范围

元数据探针：

```powershell
node scripts/audit-dsh-plugin-compatibility.mjs
```

它使用仓库内固定的元数据快照，不联网；通过 Vite 编译生产候选选择与 patch 检查，所有写入位于新临时目录。依赖声明用本机已有 semver 检查。假安装器在第一条安装调用处抛出明确的测试错误，不执行 pnpm、第三方入口或模型；输出中的 `failed` 包含这个有意停止，报告明确标记 `reachedInstallBoundary`。可选输出路径只允许新文件，已有证据不会被脚本覆盖。

本轮验证：

- 生产入口刻画 7 项检查通过；另记录 4 个工具名的策略分类。证据包含输入源码哈希、revision、dirty 状态与样本固定来源。
- `node scripts/dsh-extension-check.mjs --electron`：11 项现有合成包生命周期通过，退出码 0。它实际使用 DSH / pnpm / Electron Node 模式，PATH 排除系统 Node / pnpm，禁用公网 registry；不运行第三方样本或模型。
- 两个新增脚本的 ESLint、针对 probe 的严格 TypeScript 检查通过；研究链接与 diff 检查见本轮交付核对。

没有运行第三方完整安装、真实模型、邮箱 / 学校扫描、电脑操作、语音下载、安装包升级、跨日或长期体验。没有旧 harness 的同样本 A/B。因而本轮足以识别兼容门槛、验证现有底座及形成市场准入建议，不足以宣布“DSH 插件普遍原样兼容”。

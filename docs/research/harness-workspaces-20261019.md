# 从受限书桌到真实项目工作：DeepSeek Harness 源码对照

2026-10-19。用户要求重新研究正常项目工作所需的 harness，重点是现有工程访问、权限、执行与持续工作。本报告由一个只读研究子代理完成 DSH 审计，主代理对关键来源复核并补充 LCA 对照。

## 结论与证据范围

当前 LCA 的问题首先是工作环境契约：把角色的书桌作为用户任务的唯一文件根，并把普通工程命令限制在小型纯文本副本中。循环、工具日志、取消和版本检查已经存在，但不足以让真实项目工作成立。

DSH 直接登记已有项目目录，以 session cwd 原地读取和执行，将会话权限与临时升级审批分开。它值得作为真实执行后端候选，不必预设再手写一套；当前 SDK 与 Windows 边界仍需专门接入实验。

| 项目 | 本次读取基线 |
| --- | --- |
| DSH | 本地 `D:/deepseek-harness`，`687f282e8625c6b8d11ff58211a90524be2e4317`；开始和结束均无未提交修改。该 checkout 的相关包版本为 `0.2.1-rc.2`，不代表 npm 最新版本。 |
| LCA | `bfa7ea4895054d0da392a4a591e0f92e9f5118b9`；已有 `art/gen-log.jsonl` 修改保留。本报告不改执行代码。 |
| 已完成 | 阅读源码、profile、接口与测试断言，对照职责和失败边界。 |
| 未完成 | 没有安装或启动 DSH、调用模型、运行参考测试、实测内存峰值，也没有接入新后端。 |

## 1. LCA 为什么不能直接研究一个正常仓库

### 工作目录被角色存储目录固定

`createDesk(join(roomRoot, '书桌'))` 同时供给心流、影子记录和命令执行；命令的 `deskRoot` 也是同一路径。当前没有选择用户工程并绑定到任务的独立工作区层。

来源：[装配位置](../../src/main/index.ts#L429)、[命令根目录](../../src/main/index.ts#L451)。

`deskPathSchema` 只接受书桌内相对路径，禁止绝对路径、反斜杠、冒号与以点或空格开头的路径段。因此常见 `.git` / `.github` / `.env` 等路径也不属于这个文本项目格式。把仓库地址写进聊天不会建立可读取该目录的 capability。

来源：[路径契约](../../src/main/heart-flow/desk.ts#L6)、[根内解析](../../src/main/heart-flow/desk.ts#L15)。

### 命令操作的是小型完整文本项目副本

| 当前限制 | 对普通工程的影响 |
| --- | --- |
| 单文件最多 64,000 bytes，严格 UTF-8，不允许 binary | 大源码、锁文件、图片或普通构建产物可能直接拒绝。 |
| 最多 300 文件、1,000 目录项、8 层目录 | 仓库及依赖树经常超过限制；不是按需限制一次读取的输出。 |
| 禁止链接 / 硬链接和不支持的路径 | 常见包管理器的链接布局不能直接使用。 |
| 每次命令创建全量副本并核对全量哈希 | 额外磁盘占用、读写与等待；并非原项目中的真实工作环境。 |
| 默认 5 秒、最多 30 秒，纯系统 PATH、无网络 | 正常构建、测试、安装依赖和开发服务很难成立；项目内外的开发工具不能假定可用。 |
| 每次命令重新人工批准 | 即使用户已明确要完成同一任务，也会反复中断执行。 |

源码：[完整树读取](../../src/main/desk-command/snapshot.ts#L9)、[副本与校验](../../src/main/desk-command/snapshot.ts#L44)、[审批后再次校验](../../src/main/desk-command/service.ts#L67)、[时限 schema](../../src/main/desk-command/schema.ts#L2)、[Job 与环境](../../native/desk-command/DeskCommand.cs#L105)。

复制项目首先增加磁盘占用；当前实现还把完整文本树保存在 `Map<string,string>`，多次重读并计算哈希，因此也有内存与 I/O 成本。这里只确认算法与数据结构，没有测量峰值 RSS、实际耗时或给出虚构倍数。更直接的问题是：很多正常项目根本不满足这个容器格式。

### 查阅工具本身也不足

`desk.list` 最多给 300 文件；`desk_find` 是路径子串匹配；`desk_grep` 先截前 100 个合格文件，再读全文做字面匹配，只返回路径，没有行号或命中上下文。直接放宽根目录仍不能把它升级为完整仓库研究工具。

来源：[list](../../src/main/heart-flow/desk.ts#L38)、[现有工具](../../src/main/heart-flow/service.ts#L235)。

### 已有循环应该保留什么

LCA 已有模型 → 工具 → 结果落盘 → 下一模型步骤的循环，默认每回合最多 12 次模型步骤；这不等于最多 12 次工具调用。中断会补齐未关闭工具结果，重启不盲目重放外部动作。

来源：[步骤预算](../../src/main/harness/loop.ts#L106)、[工具结果与继续](../../src/main/harness/loop.ts#L138)、[中断恢复](../../src/main/harness/loop.ts#L69)。

因此工作区、工具、进程与会话协议应成为改造重点。既有测试证明了受限书桌链路的行为，不自动证明普通用户仓库已经能端到端工作。

## 2. DSH 怎样直接工作在现有项目上

`WorkspaceRegistry.create(path)` 对现有目录调用 realpath、检查目录并登记 canonical path，没有复制项目。API 创建 Session 时接收 `workspaceId` 或 `cwd`，从登记路径启动会话。

来源：[登记现有目录](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/workspace/workspace/src/index.ts#L238)、[Session 创建](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/commands.ts#L111)。

需要分开理解三个概念：

| 概念 | DSH 中的作用 |
| --- | --- |
| WorkspaceRegistry | 项目标题、排序、Session 分组等组织实体，不是文件权限权威。 |
| Session header.cwd | 初始项目位置，也参与解析不可变的 sandbox root。 |
| effective cwd | 后续文件 / 命令的工作位置，有独立持久投影；切换 cwd 不自动扩大权限。 |

文件工具每次取得当前会话的 effective cwd，再由 local fs 原地 resolve / read / write。当前 policy 仍只有一个 workspaceRoot，不能把“绝对路径可读、cwd 可切换”说成完整的多根分别授权体系。

来源：[工具 cwd](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/tool-fs/src/session-cwd.ts#L17)、[working-directory 投影](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/working-directory/src/index.ts#L82)、[权限根解析](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sandbox/sandbox-policy/src/index.ts#L164)。

## 3. 文件、搜索与执行工具的完整性

| 能力 | DSH 当前实现 | 对 LCA 的启发 |
| --- | --- | --- |
| 阅读 | offset / limit、行号、有界行长与输出；大文件走 stream | 限制单次输出，不把整个项目限制成 64 KB 文件集合。 |
| 搜索 | glob / grep 通过打包 ripgrep，结果有 inline 上限及 spill | 范围搜索、命中上下文、截断标记和继续读取。 |
| 修改 | write / edit 原地工作，观察版本与写入临界区校验 | 保留先读后改和冲突检查，避免每条命令复制整仓。 |
| 真实命令 | Windows pwsh、真实 cwd、进程树生命周期、输出上限 | 允许使用工程环境，读到真实退出与输出。 |
| 长任务 | foreground timeout 可转 job，job_output / job_kill 续读和停止 | 超过一小段等待不等于强杀整个正常工作。 |

阅读默认最多 2,000 行，≥10 MiB 或未知大小走 stream；输出窗口有额外上限。为了准确 totalLines，仍可能扫描到 EOF，不能声称只读请求窗口的磁盘字节。搜索也有 raw stdout 上限，溢出明确失败。

来源：[read caps](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/tool-fs/src/read.ts#L15)、[读取路由](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/tool-fs/src/read.ts#L137)、[窗口与总行数](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/tool-fs/src/read-render.ts#L102)、[搜索执行](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/tool-fs-search/src/search-core.ts#L234)。

Windows local shell 默认 timeout 为 120 秒、最大 600 秒；工具层另支持 job。当前 base 没有看到统一的模型 apply_patch 工具，主要修改入口为 write / edit。LCA 不应凭工具名称推断具备相同能力。

来源：[pwsh budgets](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/shell/pwsh-local/src/index.ts#L126)、[job 分支](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/shell/tool-pwsh/src/index.ts#L523)。

DSH 的 glob 当前带 `--no-ignore --hidden` 并排除 VCS metadata。这不是 LCA 必须照搬的产品策略；项目搜索应明确处理依赖、构建产物、私人文件和用户排除项。

来源：[glob argv](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/tool-fs-search/src/glob.ts#L89)。

## 4. 权限与审批：两个维度

DSH shipped base 显式使用 `workspace-write + ask`；Windows 选 pwsh-sandbox。底层类默认值与完整 profile 默认值不能混淆。

| standing mode | 作用 |
| --- | --- |
| read-only | 常规写入受限，需要改变权限才进行更多动作。 |
| workspace-write | 初始项目内正常写入与对应命令在既有授权内执行。 |
| danger-full-access | 放开该文件 confinement，不能描述成只对某一目录授权。 |

approval 的 `ask` 决定更宽权限请求如何询问；`never` 是不弹窗且拒绝需要审批的动作，不表示自动允许。请求与已有 effective mode 相同，无需再批准。持久授权来自 Session 的 preset / mode / policy 投影，不是每条命令重新确认。

没有看到命令 prefix-rule 或某目录“以后一直允许”的逐次审批记忆；不能把期望能力写成 DSH 已有接口。

来源：[base 默认与 presets](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml#L237)、[升级判断](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sandbox/sandbox/src/escalation.ts#L171)、[权限投影](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/interaction/permission-presets/src/index.ts#L264)、[审批 policy](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/interaction/user-approval/src/index.ts#L58)。

### Windows 的真实边界

文件工具的 fs-sandbox 对 write / edit 做 canonical path fence，所有 mode 的读取仍放行；源码明确这不是 kernel security boundary。shell 的 Windows runner 使用 restricted token / ACL，限制真实进程写入，不能把 cwd 当作隔离。

该 Windows backend 明确 partial：读取、网络和进程可见性不受此写隔离限制；工作目录 ACL grant 还会保留用于跨会话复用。Job Object 负责进程树管理，也不能被当作文件或网络隔离。

来源：[fs fence 声明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/fs-sandbox/src/index.ts#L2)、[Windows 明确限制](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sandbox/sandbox-windows-acl/src/index.ts#L26)、[进程 Job](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subprocess/subprocess-local/src/windows-job.ts#L125)。

因此，LCA 需要明确“同用户信任模式”与“严格隔离的执行环境”。单独一个 DSH 进程、不把数据库路径放进提示词、或只隐藏配置界面，都不能证明宿主私有文件无法被命令读取。强隔离可以另外评估 OS / 容器 / VM 与映射目录，不应在未验证时承诺。Windows Sandbox 有映射目录及网络配置，但也有平台与内存开销，不作为本报告的默认选择：[Microsoft 配置说明](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)。

## 5. 执行循环、取消与完成

- `steer` 进入 next-step，followup 进入 next-turn；工具结果持久化后才推进下一步。
- 有界并行工具批次在取消后等待已启动调用收敛，为未启动调用补结果，避免留下悬空工具记录。
- 恢复会修补 interrupted turn，不无条件重放上次动作。
- 长命令有后台 job 句柄，可继续读输出和终止；Goal 另提供有轮数预算的跨 turn 推进。
- compaction 挂在 pre-step，保留原始事件，压缩区域不切开工具 call / result。

来源：[steer / cancel](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L154)、[工具取消结算](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/tool-calls.ts#L238)、[Goal driver](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/goal/goal-round-driver/src/index.ts#L172)、[压缩](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction-basic/src/index.ts#L158)。

普通 turn 的 completed 表示循环结束，Goal.complete 也是合法状态迁移，没有通用的产物 / 测试验证器。SDK 的 idle 和最后一段助手文字都不能代替 LCA 对文件、命令和任务结果的核验。LCA 的资源账本与完成证据不能因换后端而消失。

来源：[普通结束判断](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L547)、[Goal.complete](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/goal/goal/src/index.ts#L391)。

## 6. 能否把 DSH 真正接成执行后端

官方 TS SDK 提供 `DeepSeekHarness` / `HarnessClient`，以 named profile 和 stdio JSON-RPC 启动独立 runtime，支持 patches、dshHome、processCwd、session cwd 与完整 child env。

来源：[SDK options](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/src/types.ts#L24)、[launch](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/src/launch.ts#L128)。

接入候选并非即插即用，以下是当前源码中的实际缺口：

| 缺口 | 接入要求 |
| --- | --- |
| RPC 只有 initialize / prompt / resume / wait / cwd / shutdown | 没有单会话 cancel / close 或审批 response；须补协议，或先采用一个工作任务独占一个 runtime 的明确边界。 |
| SDK 请求 timeout 只放弃等待，服务端任务可能继续 | 超时不能当取消；停止必须有执行端确认与进程生命周期收敛。 |
| 高层 run 返回入队到 idle 的活动区间 | steering / 排队工作可能参与，finalResponse 不能直接归因于某个请求，更不能当成功。 |
| sdk profile 的 maxTokensAsSuccess 默认 true | 接入实验必须显式 false，读取终态 reason，不把截断输出报成成功。 |
| sdk-minimal 以 persistent terminal 为主，默认 danger-full-access | 不能把名称 minimal 当作保守权限模板。 |
| launch 使用 process.execPath | Electron main 的 execPath 是 Electron，需要明确 Node carrier / helper 或验证 Electron Node 模式。 |
| 默认继承父环境 | 显式构造 child env；不要把模型、邮箱、Electron 与其他父环境变量整体透传。 |
| provider 需要已安装 adapter | 不能假定现有任意 OpenAI-compatible 配置可直接透传，不擅自更换用户供应商。 |
| pre-stable、多包与 profile 协作 | 固定整体版本，明确升级契约与包装成本。 |

来源：[RPC method switch](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/server/src/server.ts#L343)、[timeout 是放弃等待](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/src/client.ts#L180)、[run result](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/src/types.ts#L69)、[maxTokensAsSuccess](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-app/cordis.patch.yml#L21)、[minimal mode](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/cordis.patch.yml#L73)、[provider 准入](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/server/src/server.ts#L155)。

工作日志也属于数据归属问题。独立 dshHome 只能分开存储位置，不能自动阻止同用户进程读取 LCA 文件。只传任务所需上下文，避免把校园原文、私人记忆全库或配置库送入后端；工作来源和普通记忆之间继续保留出口规则。

## 7. 三种路线与建议

| 路线 | 收益 | 代价 |
| --- | --- | --- |
| 改造现有 LCA 执行器 | 保留产品行为和状态所有权，可逐步迁移 | 仍需维护 shell、Windows 权限、长任务、工具和上下文。 |
| DSH 独立后端，LCA 主进程适配 | 复用持续维护的工作执行链，角色、UI、校园与私人状态留在 LCA | 补取消 / 审批 / 终态 / provider / Windows 包装；固定 runtime 版本。 |
| 进程内复用少量 DSH 包 | 个别机制可重用 | 多数是 Cordis service / provider / consumer，连同 peer 包和 native 依赖，不能当零耦合 util。 |

建议优先做**独立后端的最小验证**，同时定义 LCA 拥有的工作区与执行适配接口，使后端可以替换。源码研究没有证明它一定优于改造现有执行器；现在不锁定最终路线，也不立即替换整个 harness。

## 8. 产品需要分开的三个概念

| 概念 | 建议职责 |
| --- | --- |
| 她的书桌 | 角色自己的作品、生活与可交付产物，不作为用户项目的唯一存放位置。 |
| 用户项目 | 原有目录的引用、任务授权、读写范围、有效 cwd；明确需要隔离分支时才创建 worktree / 副本。 |
| 心流 | 任务执行与交流情境：计划、工具、输出、等待、取消、验证、恢复。 |

用户选择项目并授予任务范围后，范围内的正常读取、修改和检查应能连续进行。越界能力、破坏性操作和外部副作用采用清楚的策略，不把每次普通工作都变成新的确认关卡；策略必须与执行提供者能保证的真实边界一致。

## 9. 下一步用什么验收

以下为建议实验，尚未执行，也不构成对真实服务调用的授权：

1. 用户选择一个现有仓库，原地只读调研，不复制到书桌；包含 `.git`、二进制和依赖目录时仍能按排除规则工作。
2. 搜索一个不在前 100 文件中的已知符号，返回准确路径、行号与上下文；分页读大文件，明确截断，不全量装载工程。
3. 在授权项目中做一项小修改，保留已有 dirty 工作，并运行项目本来就有的检查。长任务能继续读输出。
4. 用户插话修改要求，下一步骤能接受；取消后核对工具结果、子进程树和终态，不重复已发生的动作。
5. 关闭再打开可以显式续做；不重放旧批准，不丢失工作日志，不把代码、输出和外部原文抽成普通共同经历。
6. 并发修改导致版本冲突时重新读取并处理；done 只有在相关产物和验证证据成立时才作为工作结果呈现。

第一项用于验证“这个 Agent 能否正常接触用户的工作”，后面才分别验证实际修改、长任务、权限和持续性。模型成本、安装、隐私与 Windows 隔离仍需各自的运行证据。

## 10. 后续复核入口

本次仅阅读以下测试，不声称已运行：

- cwd 与权限：`packages/session/working-directory/tests/working-directory.spec.ts`、`packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts`、`packages/interaction/permission-presets/tests/permission-presets.spec.ts`。
- 搜索与输出：`packages/fs/tool-fs-search/tests/tools.spec.ts`。
- Windows：`packages/sandbox/sandbox-local/tests/acl-grants.spec.ts`、`packages/shell/pwsh-sandbox/tests/acl.e2e.ts`。
- 中断恢复：`packages/core/agent-loop/tests/resume.spec.ts`。
- SDK：`packages/sdk/server/tests/resume.spec.ts`、`packages/sdk/server/tests/wait.spec.ts`、`packages/sdk/client/tests/dispose.spec.ts`。

以上路径相对 DSH 固定 checkout。继续做接入时先验证这些契约，再增加 LCA 原生进程、书本 UI 和真实项目任务的证据。

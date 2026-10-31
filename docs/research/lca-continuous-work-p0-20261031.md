# 持续工作 P0：从 main 隔离开展的初步实验

日期：2026-10-31。状态：**P0 部分验证完成，整体架构尚未接入产品**。

实验分支 `codex/continuous-work-p0` 从 `main@227e759dd403653119587ec68c0976d6ad1155b7` 建立。该提交在当天合并了 1.2 rc.3 阶段代码与验收记录；第二父提交是先前研究的 `b4f1183fd35227061ffaa1264ef70ef119448a7a`。独立 worktree 名称为 `lca-continuous-work-p0`，由 Codex 工作区管理。主工作区已有的 Agent Browser 等未提交工作保留，本轮研究文档在逐字节校验副本后迁入实验分支。

详细设计继续以 [改造计划](lca-continuous-work-plan-20261031.md) 为准；本记录只描述这次实际探查。机器可读摘要见 [P0 证据](evidence/lca-continuous-work-p0-20261031.json)，官方源码研究证据仍保存在 [原始研究清单](evidence/lca-continuous-work-research-20261031.json)。

## 1. 结论

现有 DSH bridge 的多根会话能力足以继续做交互 / 执行分离实验。它可以在 A 等待工具结果时完成 B 的请求，并保持会话历史、来源与回调绑定的隔离。但并发 `open` 的人格初始化存在真实竞态：A、B 同时打开，A 会拿到 B 的人格及后缀。本分支已做局部修复。

DSH `0.2.1-rc.2` 的待处理消息在显式 `sessionPersistence.flush()` 后，可以在进程被终止并冷恢复时保留同一个 message ID。**这只通过了持久投递的一个前置条件**：现有生产 bridge 仍没有稳定 producer delivery ID、持久 ACK 与应用级订阅 / outbox，不能据此宣称投递去重或恰好执行一次。

这轮没有替换 LCA 的执行服务、引入另一个 Agent loop，也没有让两类会话进入用户界面。完整 P0 仍未关闭。

## 2. 装置与边界

- Windows x64、Node `24.14.0`，按实验 checkout 的 `dsh/runtime/package-lock.json` 独立安装 `@deepseek-ai/dsh 0.2.1-rc.2`。未共享原 checkout 的依赖或运行 profile，未安装整套 Electron 开发依赖。
- 首次离线安装因缓存缺少 `zod 4.4.3` 失败；随后按同一锁文件正常安装 564 个包，禁用安装脚本。未修改锁文件。
- [新探针](../../scripts/dsh-continuity-probe.mjs) 经真实 DSH、真实 LCA bridge、回环 HTTP 脚本模型运行。每个场景使用独立数据目录、HOME、APPDATA、AGENTS_HOME、项目目录和动态端口；子进程只继承启动必需环境。
- [观测插件](../../scripts/fixtures/dsh-continuity-observer.mjs) 只记录 session / inbox，并在指定断点 flush。它不更改授权、不派发任务、不自动批准，也不装入生产 profile。测试控制消息会被生产 bridge 以未知命令拒绝，探针只忽略这一条预期错误。
- 两个根会话使用不同临时项目，是绑定隔离的装置，不代表产品已允许跨项目并行。脚本模型只调用两个合成 LCA 工具；真实模型、邮箱、学校扫描、付费服务和外部写入均未运行。
- 原始请求、事件、进程退出和 profile 留在忽略的 `test-results/continuous-work-p0/` 下；提交的证据只保存摘要、相对路径、文件哈希和限制。53 次模型请求全部由本地脚本应答，包含基线、纠错复核、修复后和旧回归。

## 3. 对照与结果

| 场景 | 未改 bridge 的 main 基线 | 修复后 | 能证明什么 |
| --- | --- | --- | --- |
| `serial-open` | 通过 | 通过 | A 挂起工具期间 B 完成；人格 / 后缀 / 对话 / 回调隔离；A 的来源原文只进入 A，冷恢复后的新回合退役 |
| `concurrent-open` | 人格、后缀两项失败；其余检查通过 | 全部通过 | 同时开根会话的初始化竞态已在此装置内修复 |
| `inbox-crash` | 通过 | 通过，并追加相同消息 ID 核对 | A 阻塞时收到事件，flush 后强制结束子进程；冷恢复仍能看到相同 pending message ID |
| `cancel-late` | 探针断言纠正后通过 | 通过 | 取消 A 不阻碍 B；B 完成后回送 A 的旧工具结果，在后续 500 ms 观察窗内没有重启 A |

冷恢复阶段由测试父进程拒绝模型准入，未观测到新的模型请求。它没有证明生产启动过程会正确恢复工作、自动接续目标或处理旧批准。

首次取消探针把取消前已经发出的空文本工具请求也当作“取消后回复”，造成假失败。已改为只检查取消边界后的事件；原始失败 `run-ysb9pP/cancel-late/report.json` 保留，基线复核 `run-wvdyPM` 通过。这里没有发现并修复生产取消缺陷。

初始基线 `run-ysb9pP`、修复后 `run-zfVg2J`、追加 pending ID 核对 `run-QHPAiB` 均保留。它们是不同运行，未覆盖失败数据；摘要记录各自版本的断言。

## 4. 唯一的生产代码实验改动

[bridge](../../dsh/lca-bridge/index.js) 原先在 IPC `open` 分支改写全局 `persona` / `suffix`，随后异步等待 loader、模型和 session 初始化。A 在等待时，B 改写这两个值，A 的 `setup` 随后读取了 B 的内容。

现在每次 `open` 在进入异步步骤前，把请求中的人格和后缀绑定为本次调用参数。缺省值来自 `init`；一个根会话的覆盖值不再成为另一个根会话的缺省人格。没有更改 IPC 字段、共享类型、模型准入、沙箱、工具权限或 DSH 执行循环。

已有根会话复用时如何刷新角色卡，仍沿用原逻辑；这次没有扩展为动态 persona 热更新。不要将这个小修复当作前台 / Worker 的硬权限隔离。

## 5. 已有行为回归

修复后使用独立 HOME / profile 和回环脚本模型运行现有 `scripts/dsh-bridge-check.mjs` 的四项控制，均通过：

| 控制 | 本轮结果 |
| --- | --- |
| `reference-restart` | 引用先于用户文本；时钟进入上下文；旧引用、旧时钟跨重启退役 |
| `degrade-restart` | 第三方来源触发降级询问；冷恢复后旧工具结果退役；本地合成命令完成 |
| `event-cap` | 自动事件回合按既定步数上限停止 |
| `handoff` | 聊天模型的写入交给工作模型，原调用不执行；新用户回合回到聊天模型 |

控制证据位于 `test-results/continuous-work-p0/controls-wDfSnV/report.json`。三个变更 JS 文件的 `node --check`、补丁格式、文档链接和证据 JSON 检查通过。未运行完整 typecheck / lint / 单元测试套件、Electron、打包、真实跨日、真实服务或长期日用；本轮不新增这些接受声明。

## 6. 下一步实验顺序

| 优先级 | 具体工作 | 完成门槛 |
| --- | --- | --- |
| P0.1 | 给交互根与执行根定义明确的能力配置；保持 DSH 拥有步骤 / 工具循环 | 在不同模型、并发工具和提问下，回调绑定正确；前台无法调用重工具；Worker 无法直接冒充用户交互 |
| P0.2 | 明确 `deliveryId → DSH messageId` 映射、flush ACK 与收件箱查询；先建立合成投递适配器 | 覆盖 enqueue 前、enqueue 后 flush 前、flush 后 ACK 前、消费后 ACK 前的崩溃；重试不重复入箱；未知外部结果不能自动重放 |
| P0.3 | 验证根会话取消与 DSH job / 子代理的真实生命周期 | 迟到子任务消息、待批准调用、后台 job 结束不能复活已停止工作；保留已有撤销与来源退役规则 |
| P0.4 | 建立两根会话共享额度 / 前台优先的合成压力场景 | 同一自主工作派生的所有执行共享预算；前台问答可准入；等待批准不会无限占用执行名额 |
| P1 | 在上述关键边界明确后，单独提交“接口：”共享契约 | `WorkItem / WorkRun / WorkGrant / Trigger / Subscription / Delivery` 的身份、状态、归属、版本、停止与恢复语义固定 |

任务持续性随后依赖独立于日页的 WorkItem 和 append-only 工作日志；事件订阅依赖主进程拥有的来源状态及持久投递账本；上下文管理依赖有界任务卡、按 ID 展开以及每次读取的来源 / 权限校验。现在已经验证 inbox 的一项能力，可以减少重复造队列的探索，但不能跳过这些应用层工作。

进入功能接入前保留原计划的 B0 / B1 / B2 强基线与同预算对照。此轮只有确定性脚本流程，不据此推导真实模型效率、体验延迟或 token 成本收益。

## 7. 复现

在该实验分支的独立 checkout 中：

```powershell
Push-Location dsh/runtime
npm ci --ignore-scripts --omit=dev --no-audit --no-fund
Pop-Location
node scripts/dsh-continuity-probe.mjs
```

也可只运行一个场景，例如 `node scripts/dsh-continuity-probe.mjs inbox-crash`。探针每次创建新目录，不覆盖已有证据；返回非零说明至少一项期望不成立，需查看对应 `report.json`。

基线复现应另建基于 `227e759` 的 checkout，仅复制两个探针文件及独立安装依赖，保持 bridge 不变；不要在正在使用的主工作区反复切换或覆盖源码。当前探针已纠正取消断言，因此基线预期仅 `concurrent-open` 的人格与后缀检查失败。

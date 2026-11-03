# 测试与验证

按改动选择检查，分别报告静态、合成流程、真实服务和实际使用的证据。完整脚本以 [package.json](../package.json) 为准，`pnpm run` 可查看当前列表。

## 日常检查

```powershell
pnpm typecheck
pnpm lint
pnpm test
```

纯文档改动检查链接、命令、一致性和 `git diff --check`，无需为文案重跑所有 Electron 场景。代码改动先跑相关单测与场景，扩大检查须有具体原因。

连续协作者实验分支的单会话关卡为 `node scripts/memory-conversation-gate.mjs`：固定 DSH、生产 controller／execution／记忆工具、真实文件 DuckDB，以及本地脚本模型与合成 768 维向量。验证记住→审阅→召回→纠正→原生压缩→新值及派生回复不重抽；脚本答案从实际注入的引用读取，金标准只用于断言。`smoke-memory` 另经实际书页审阅、更正、配置向量、压缩、分批日回顾及重启。两者均不代表真实模型质量。

执行关卡为 `pnpm test:continuity:execution`：一个实际 DSH 宿主、独立前台和两个工作 root、本地脚本模型及工具屏障。覆盖前台响应、同任务补充、事件幂等、指定停止、旧模型步骤在目标变更后不得执行动作，以及接收／消费回执。整条故事继续执行原生文件写入、检查点发布、立即追问、实际 SQLite 日页切换、DuckDB 更正、历史展开及次日旧摘要冲突检查；不是完整 T1–T16 或恢复验收。结果保存在 `test-results/continuity/execution/`；`continuous-work.test.ts` 检查调度、检查点与进度边界，`experience-index.test.ts` 检查长日覆盖、31 日分批汇总、失效及忘记后历史版本不复活。

GitHub `Engineering checks` 在 Windows runner 上执行锁文件安装、类型、lint 和单元测试。旧心流的 `probe:desk-command:runtime` 已随功能移除，不再作为 CI 入口；DSH、包内流程和实际升级仍按下文单独验收，不由静态 CI 结果替代。

连续协作者恢复关卡为 `node scripts/continuity-recovery-gate.mjs`：隔离 Electron 与实际 utility process，使用同一非空夹具验证完整向量、忘记回执、原 outbox、采集游标、检查点、交付水位、显式继续、旧存档和中断回滚。报告保存在 `test-results/continuity/recovery/`，不访问真实模型或镜像；Node 原生对应测试为 `continuity-backup-native.test.ts`。

`pnpm test:continuity` 对一个源码指纹顺序运行完整单测、类型和 lint、三个原生关卡、固定 DSH bridge／family／collaboration、一次生产构建及相关 Electron 场景。末尾的 T1–T16 审计只接受该次运行实际生成的报告，不查找旧的“最近通过”结果；保留每项检查和日志哈希。90 条检索样本与 24 条故事仍保留，完整真实模型回答／成本矩阵另行授权。`--list` 可查看任务列表。

自动验收现包含六个普通产品世界引用场景和生活作品入口；`test:continuity:world` 可在构建后单独执行。`test:continuity:postgres` 只对本次新建的独立 Docker pgvector 容器测试，缺环境时报告 unavailable；成功退出不意味着 PostgreSQL 已通过，需检查其 status。`test:continuity:prepare-live <本次报告目录>` 仅生成待授权的真实服务清单和额度建议，不调用模型。完整范围、失败记录及证据边界见[自动验收记录](research/continuity-automatic-acceptance-20261101.md)。

`node scripts/continuity-postgres-gate.mjs --product` 复用同一隔离数据库入口，另跑正常设置页的镜像开启、断库更正、待同步队列重启、重试幂等、带待同步删除的非空存档、恢复后新镜像代次和再次重启共七组检查。使用预置的已审阅长期记忆和本地合成向量，不调用真实模型或 embedding，也不评估长期记忆晋升质量。构建后可直接测源码；设置 `LCA_TEST_EXECUTABLE` 可测指定包，报告记录 asar 哈希。`LCA_TEST_PGVECTOR_IMAGE` 指定已经存在的本地镜像；`LCA_TEST_DATA_ROOT` 为每次新 profile 提供短路径根，报告留在 `LCA_CONTINUITY_RUN_DIR`。Windows 上不要把 SQLite profile 嵌套到较长的报告路径中；测试退出后只停止本次容器，保留数据与失败证据。

连续工作实验中的 `smoke-collaboration` 通过正常产品入口开工，保持 Worker 的成员请求阻塞，检查前台聊天、工作选择、成员步骤、任务板和停止／重启；`smoke-v12-recovery` 复用该路径，再验证待核对状态、显式继续、非空工作存档与两次冷启动。早期由前台直接创建成员的 P5／P6 脚本保留于 Git 历史；其固定 DSH 来源、安全和成员控制合同仍由 bridge／family／collaboration 检查承担，不能把新脚本报告称作旧 UI 矩阵全量重跑。

大体积合成数据可通过 `LCA_TEST_DATA_ROOT`（相关 Electron profile）、`LCA_TEST_ARTIFACTS_DIR`（原生单测）和 `LCA_TEST_CACHE_ROOT` 指向单独卷；每个场景仍创建独立 ID，端口顺序使用或由系统分配。`pnpm test:continuity:package` 读取 `LCA_RELEASE_DIR` 的固定构建回执，核对原生模块后在包内 EXE 执行 SQLite、完整非空恢复、记忆书页和工作恢复。它不安装或卸载应用，也不替代完整 `test:package`、升级、第二台 Windows 或真实服务验收。

## 主要场景

| 命令 | 核验重点 |
| --- | --- |
| `test:electron`、`probe:sqlite`、`probe:journal` | 原生模块、受限 IPC、日志和重启 |
| `test:harness`、`test:failure-narrator`、`test:questions` | 工具回合、取消、失败与有界询问 |
| `test:developer` | 开发者 profile、调试 MCP、脚本模型经本地接口跑在 DSH 上、场景导出与展位拒绝 |
| `test:providers`、`test:model-slots`、`test:model-routing` | 配置、热路由、隔离、上下文、候选和重启；`test:providers` 另覆盖经 DSH 的连接测试、错误密钥的三角警示与详情对话框（服务商原话、请求地址、Esc 关闭后焦点返回）及快照不含密钥 |
| `test:documents`、`test:campus` | 文件解析、原文边界、版本确认与真实本地交付 |
| `test:plugins`、`test:mcp`、`test:student-hub`、`test:student-hub-candidates` | 安装、指纹、工具白名单与兼容入口 |
| `test:memory`、`test:history`、`test:optical` | 来源、摘要、旧页、可选光学守卫和恢复 |
| `test:pomodoro`、`test:mini`、`test:resources` | 计时、双窗口、显示器边界与资源准入 |
| `test:dsh-bridge` | 真实 DSH 运行时 + 本地脚本模型：引用及本地时间 / 时区随开场消息、下一轮退役（含重启后）；第三方结果降级本轮、下一轮退役（含重启后）；聊天与工作模型交接、思考档位、自主额度、事件步数上限、项目信任；`probe` 场景经真实适配器做连接测试（一条路由通过，另一条返回 401 与服务商原话） |
| `test:state-routing` | 隔离 Electron + 本地 HTTP：门牌直接工作、文本状态交接、过期回复拒绝、状态持久化与无重放重启。DSH bridge 的 `state-*` 场景另覆盖截断、主进程拒绝及交接后来源限制不降级 |
| `test:model-capabilities` | 隔离 Electron / HOME + 本地 HTTP：手动能力保存及 DSH 元数据、思考参数映射、off 的省略 / 显式值 / 默认语义、输出上限、图片正反路径、模型切换、重启、恢复自动与凭据隔离 |
| `test:dsh-family` | 1.2 P2：临时项目／HOME／profile、本机脚本模型；真实 DSH + 生产 bridge 的成员审批、撤销、闲置主角色、多层委派、跨项目拒绝、迟到消息、摘要与冷恢复，原 14 场景，加 P3 的 `spawn-manager` 权限绕过回归，共 15 场景。fixture 不代改权限或退役内容；合成证据边界见 [P2 回执](research/v1.2-p2-20261023.md)。原反例保留在 [P0 / P1 回执](research/v1.2-p0-p1-20261023.md)对应提交 |
| `test:dsh-extensions` | P3：隔离 HOME / profile / 本地合成 bundle，生产 main 服务和 bridge、Electron Node 模式与随附 pnpm；PATH 排除系统 Node / pnpm。完整生命周期、独立脚本批准、运行中取消、丢失 IPC 回执冷恢复、核心保护与加载失败状态。不是页面或安装升级验收，见 [P3 回执](research/v1.2-p3-20261023.md) |
| `test:extensions` | P4：隔离 Electron 书页、原生选择的合成目录与逐次审批；本地 bundle 安装 / 启停 / 重启 / 移除、独立构建批准、丢失回执后同 ID 核对，Markdown 技能导入 / 优先级 / 修改删除 / 跨项目 / 冷启，以及实际 DSH 技能与 MCP 调用。仅本机合成模型与服务，截图和回执写到 `test-results/p4-*`，见 [P4 回执](research/v1.2-p4-20261023.md) |
| `test:dsh-collaboration` | P5：固定 DSH 的普通委派 / Team 共存、单一控制路由、成员关系、任务 revision / 依赖 / 范围提示、持久来源退役、两类容量、失败占位、断连回执、冷恢复及整组自主额度；Electron Node 模式，隔离 HOME / profile，PATH 排除系统 Node / pnpm |
| `test:collaboration` | P5：实际书页中的成员和任务、消息、单成员停止、整组停止、断连后刷新核对同一操作、冷恢复及窄窗口；V1：有成员干活时左页拉远、人数与忙碌者对应，全部停下回近景，冷恢复后手动看房间、点帮手的卡片与“更多”；只用本机脚本模型。复用已构建产物可运行 `node scripts/smoke-collaboration.mjs`；设置 `LCA_TEST_EXECUTABLE` 可指定包内 EXE。证据在 `test-results/p5-*`，见 [P5 回执](research/v1.2-p5-20261024.md) |
| `test:v12-recovery` | P6：跨项目、冷启动、审批中取消、成员忙碌边界、DSH 退出、来源退役的实际请求、可控时钟日切、私人存档恢复及再次冷启。隔离 profile / HOME / 项目、本机脚本模型；可用 `LCA_TEST_EXECUTABLE` 复跑包内 EXE。不是实际跨日长期使用，见 [P6 回执](research/v1.2-p6-20261024.md) |
| `test:sleep` | 隔离 Electron 与合成时钟 / 模型：手动睡眠、夜灯 / 熄灯、夜间安全日切、06:00 自动醒来、08:22 恢复时校正、手动存档保留、最终素材与动画完成截图 |
| `test:life-port`、`test:life-work`、`test:room` | 生活状态、实际产物、日记与重启 |
| `test:gifts`、`test:backup`、`test:characters` | 礼物同意、存档与角色作用域 |
| `test:package --unpacked-only` | 构建回执、包内 EXE 和独立测试数据 |

表中省略 `pnpm` 前缀。多数 Electron 脚本自带 build；复用构建或指定安装 EXE 时先读对应脚本，不能随意绕过前置检查。

`dsh-bridge-check.mjs state-source-restart` 覆盖读外部来源后切换状态、下一轮来源退役并执行新命令、第三轮冷恢复。系统 / 开发者提示的替换记录必须在 DSH 已打开的步骤内写入当前坐标：桥在 `agent/request` 钩子完成退役，再允许模型请求；不能在 `session/event` 内递归追加。会话不存在才允许新建，损坏或不可读的既有日志保留原错误和文件。此修复防止生成新的损坏记录，不自动修复旧日志。

团队远景 V2 补充检查：`tests/unit/dsh-member-focus.test.ts` 用假时钟核对窗口、换位与长思考；`dsh-member-steps.test.ts` 验证有界回放、路径 / URL 摘要、来源退役后仍隐藏旧目标和字段剥离；`team-scene.test.ts` 验证按种类摆位、稳定座位、溢出与家具深度。`test:dsh-collaboration` 新增工具 / 思考 / 同伴消息阶段、最近 12 步、成败、已卸载成员的只读回放、跨根拒绝和受限来源隐藏目标。`test:collaboration` 新增实际子代理读文件后的 `data-station`、中文步骤卡片与快照无目标检查。

`node scripts/team-room-preview.mjs` 用本机已装 Chrome 检查 `team-working`、`team-workstations`、`team-statuses`、`team-blocked` 假场景，保存工位 / 状态、白天、夜间、减少动画、干净 / 受限卡片和窄窗口截图到 `test-results/team-v2-preview/`。验证全部 15 张小桃子与 2 台电脑、每个茶桌座位一台电脑、可见头部点击、键盘与焦点返回，并检查隐藏房间不截获点击。开发场景切换条在检查书页切镜前移到顶部；实际安装包不带此工具条。`--serve` 只启动预览服务，端口由 `LCA_SHOT_PORT` 指定。不下载浏览器，不调用真实模型；这些截图不代表真实模型日用验收。

若需要单独复核团队房间，可在 build 后运行 `node scripts/smoke-collaboration.mjs --team-room-only`：仍检查消息、停止、任务操作、冷恢复和新书页路径，只把“丢失回执”故障注入换成正常重开任务。回执写明 `teamOnly: true`，不能称为完整验收。2026-10-28 已修复回执先通知后落盘的竞态并通过完整脚本，旧失败证据保留。

2026-10-28 的检查结果、失败证据与美术交接见[团队远景 V2 回执](research/team-room-v2-20261028.md)。

开发者场景的脚本回复由本地模型接口交给 DSH：脚本里不带 `lca_` 前缀的 LCA 工具名会按 DSH 提供的名字发出；`get_context` 是 DSH 最近一次发给模型的请求。她的回合比旧循环慢一点：脚本要等模型请求真正到达（看 `get_context`）再拨时钟，她说话时被拒绝的命令（如导出存档）用 `whenIdle` 重发。

1.1 移除了旧心流、书桌命令、预览电脑、网页读取、分身和任务对象，以及它们的脚本（`test:heart-flow`、`test:task-object`、`test:timeline-safety` 等）与审计探针 `probe-context-continuity`；历史结果留在 git 记录和 [研究记录](research/) 里。旧心流的会话仍可在设置里查阅状态与差异，`test:room` 覆盖。

测试窗口默认透明并使用 `showInactive`，不抢焦点；需要目视验收时设置 `LCA_TEST_SILENT=0`。不另装 Playwright 浏览器。开发与测试使用合成来源和独立 profile，不借参考项目的真实数据填样例。

## 真实服务与资源

真实请求必须属于当前获授权任务，配置可用不等于授权调用。普通文档、单测或合成回归不会自动升级成以下探针：

- `test:real-model` 要求显式 `LCA_REAL_MODEL=1` 与授权 providers 文件；检查流式、工具往返、普通 UI 与 `probe:cache-live` 缓存 usage 对账，结果不打印正文或密钥。
- `probe:cache-live`（M1 缓存观测）使用合成提示词与独立临时 profile，最多 6 次调用 / 20,000 输入 token / 90 秒单次超时；报告只含数字、布尔与槽位别名，验证供应商原始 usage 与 `model/attempt`、重启后 journal 三方一致。`LCA_CACHE_PROBE_PAIR_SLOTS` 可指定做相同前缀两次的槽位，`LCA_CACHE_PROBE_REPORT` 写本地证据。两种供应商形状已于 2026-10-19 用授权端点完成真实 payload 验证；换端点后重跑即可复验。
- `probe:privacy` / `probe:model` / `probe:harness` 可能调用已配置模型。`probe:harness` 用真实模型跑一个 DSH 回合并调用一次 LCA 时钟工具。失败不回退 fake，真实质量与连通分别评价。

`node scripts/probe-continuity-provider.mjs` 是单独授权的最小 OpenAI 兼容 provider 诊断：固定五个协议请求，再运行一次 DSH 时钟往返；最多 8 次实际转发、128,000 预留单位、零自主预算，单次网络等待 45 秒。需设置 `LCA_REAL_MODEL=1`、授权的 `LCA_PROVIDERS_FILE`、固定候选 `LCA_TEST_EXECUTABLE` 和全新的 `LCA_PROVIDER_PROBE_RUN`；已有运行回执拒绝覆盖。`--self-test` 只调用本地假服务并验证超限拒绝，不读取真实连接。该入口在隔离的包内 Electron 主进程载入源码执行适配器，使用包内 DSH／桥接文件；不是普通产品书页和 Worker 整场景。真实报告只含状态、计数、时间和用量；运行时不得自动重试整批或重置账本。当前首批结果见[真实探针记录](research/continuity-provider-live-20261101.md)。

`pnpm test:continuity:world-live` 则走指定包的普通产品书页，使用六个世界状态和逐例语义审阅。独立授权上限为 12 次、256,000 预留单位、零自主额度；运行目录由 `LCA_WORLD_PROBE_RUN` 指定，`--self-test` 不访问真实服务。每次转发绑定已发布且未消费的应用准入回执，报告区分产品完成、语义审阅和网关失败。首次真实批次因第五例网关失败停止，未执行第六例；不能重置账本自动重试。结果及离线修复见[世界表达真实复测](research/continuity-world-live-20261101.md)。

指定 `LCA_WORLD_PROBE_CASE=early-return` 可只运行第五例，硬限 1 次请求／16,000 单位。`--self-test --hold-after-done` 用本地服务复现协议已结束而 HTTP 仍开放的条件；原探针误报、修复及额外授权后的真实单例结果见[单例复测记录](research/continuity-world-single-retest-20261101.md)。

`test:continuity:work-live` 与 `test:continuity:memory-live` 通过指定包的普通产品入口执行工作和记忆整链路。`--self-test` 使用本地脚本服务；仅此模式下，省略 `LCA_TEST_EXECUTABLE` 可以复用 `pnpm build` 后的源码 Electron，报告记录 out 文件与桥接指纹，不能记为包内验收。两种模式均要求全新的 `LCA_CONTINUITY_PROBE_RUN`。真实执行仍要求固定包、匹配包／桥接指纹和批次额度的一次性授权。`test:continuity:prepare-probe <work目录> <memory目录> <新输出目录>` 只生成待授权模板。工作交付的自主额度包含在总额内；记忆还单独限制向量请求及字符数。结果、恢复缺陷修复、使用方法和未测边界见[工作／记忆预跑](research/continuity-probes-preflight-20261102.md)。取消世界单例另见[真实结果](research/continuity-world-cancelled-20261102.md)。

工作 self-test 故意重放 `inspect_work → 猜测 update_work → 额外 start_work`，再测试用户撤回后再次调用修改也被拒绝；随后验证正常澄清的两条原文确实进入同一工作。含糊场景对整个工作集合、目标版本、代次和状态做前后比较，并要求实际出现澄清，不能只检查原先两项的版本。`work-request.test.ts` 另覆盖原文作用域、名称与旧输出值混淆、审批／未提交回答、重复创建、重开去重及明确请求的正常执行。

此前独立候选 `continuity.6` 的同包基础四项、本地工作八组、记忆七组和真实本机 PostgreSQL 镜像产品七组通过，见[候选 6 验收](research/continuity-candidate6-acceptance-20261102.md)。该本地轮次没有安装／发布或真实模型调用。`continuity.5` 的真实记忆七组及人工语义复核完成，但收尾 JSON 读取竞态使原自动报告失败；工作在排序断言处停止，当轮未执行尾段。旧版本结果、消耗及 Docker 修复见[候选 5 续验](research/continuity-candidate5-acceptance-20261102.md)，此前失败见[首轮服务实测](research/continuity-services-20261102.md)。`dsh-bridge-check.mjs state-foreground state-foreground-sign state-worker` 可离线验证独立车道下的门牌与工具范围。

上述本地轮次之后，候选 6 的新授权真实工作批次完成 31 次完整响应；前四组通过，第五组含糊指令实际改变 WORK_B 版本并额外创建工作，首次失败后已停止并关闭额度。这个缺陷与旧排序误报不同；停止／恢复尾段没有继续执行，见[真实工作失败与边界](research/continuity-candidate6-work-live-20261102.md)。

该缺陷的主进程修复、原文与澄清边界、故意发送错误工具调用的回归和本机候选 8 结果见[修复与离线复验](research/continuity-work-request-20261103.md)。随后获授权的[候选 8 真实工作复测](research/continuity-candidate8-work-live-20261103.md)以 36 次请求完成九项检查与语义核对，零向量调用；该批已关闭，下一批另需授权，候选 6／8 的余额均不复用。

同一生产源码的 [22 步骤完整统一回归](research/continuity-candidate8-regression-20261103.md)随后通过，包含 968 项单测、另跑的 8 项本机 PostgreSQL 集成检查及 T1–T16。新增 `node scripts/probe-embedding-inputs.mjs --self-test` 在隔离 Electron 中调用生产适配器，单独验证 Voyage `document/query` 参数，不能替代普通产品记忆故事。固定包、新目录、授权模板和上限见[记忆／Voyage 复测说明](research/continuity-candidate8-memory-plan-20261103.md)；真实模式需单独授权，旧报告和额度不可复用。

该次获授权的[真实记忆复测](research/continuity-candidate8-memory-live-20261103.md)中参数两项通过，记忆前六组和恢复状态已验证，但恢复后的第 33 次模型请求触及 32 次硬上限；保留自动 `ok:false`，没有用事后九条回复复核替代完整通过。下一次应在新授权下独立补恢复尾段。

人工审阅 `answers-for-review.json` 后，先在另一文件写完 `{ "batch": "work或memory", "accepted": true, "reason": "实际核对依据" }`，再用 `node scripts/publish-continuity-review.mjs <运行目录> <决定文件>` 原子发布。若审阅不通过，设置 `accepted: false` 并说明原因。发布器不覆盖已有回执、不修改已结束批次，不调用模型。不要直接创建目标 `semantic-review.json` 后逐步写入。

- `probe:student-hub-live` 要求显式 `LCA_STUDENT_HUB_LIVE=1`，使用临时库的只读邮件范围；不扩大到课程提交或外部写入。
- `probe:imap` 读取获授权文件夹；`probe:rodin` 会提交真实生成任务并可能收费。旧任务的预算不作为新任务的通行证。
- `test:pomodoro:realtime` 使用真实时间，区别于冻结或加速时钟。

## 安装与发布

`test:package --unpacked-only` 不安装 / 卸载，不能称为安装器升级验收。默认 `test:package` 发现已有同名用户安装会拒绝，不覆盖用户实例。

所有支持 `LCA_TEST_EXECUTABLE` 的书页检查都必须启动指定的包内 EXE；共同初始化还会核对实际页面来自该 EXE 的 `resources/app.asar`。不能把源码 Electron 的结果记到候选包上。若完整检查中断，保留失败回执；只有固定同一个 app.asar 哈希、逐项记录脚本与辅助函数哈希，才能续跑未完成的矩阵。续跑集合通过不等于原来中断的整条命令退出码为 0。

包内矩阵的扩展场景加 `--verify-node-build`：应用 PATH 仅保留 Windows 目录，确认 `node` / `pnpm` 无法解析，再经书页分别批准安装和 JavaScript 构建，核对实际构建产物与执行二进制属于同一 Electron。可以用 `node scripts/smoke-extensions.mjs --verify-node-build` 单独复跑；此项仍是本机隔离证据，不代替第二机验收。

rc.2 之后的候选还需补跑门牌 / 文本状态交接与模型能力书页；它们目前未列入 `smoke-package.mjs` 的 34 项矩阵。完整矩阵已包含 `smoke-collaboration.mjs` 及 `smoke-v12-recovery.mjs`，应核对报告中的实际 EXE、工作选择及恢复检查和同一 app.asar 哈希。以下命令按顺序执行，`LCA_RELEASE_DIR` 先指向本轮候选的干净绝对输出目录：

```powershell
node scripts/smoke-package.mjs --unpacked-only
$env:LCA_TEST_EXECUTABLE = Join-Path $env:LCA_RELEASE_DIR 'win-unpacked/LoveCollegeAgent.exe'
node scripts/smoke-state-routing.mjs
node scripts/smoke-model-capabilities.mjs
Remove-Item Env:LCA_TEST_EXECUTABLE
# 核对固定 1.1.0 安装器并设置 LCA_BASELINE_INSTALLER 后，串行运行：
node scripts/smoke-v12-upgrade.mjs
```

每一步确认成功再继续；失败时保留原报告与日志，不用后一条命令的退出码覆盖前一条。团队素材另核对包内活跃图片哈希及旧坐姿未打包，预览截图仍属于源码合成视觉证据，不能替代包内协作流程。

DSH 运行时与 `resources/lca-bridge` 位于 asar 外；修改桥接时 app.asar 可以不变。候选身份和续跑还须固定安装器及这些目录的逐文件哈希，不能把相同 app.asar 当作整包相同。

`node scripts/smoke-v12-upgrade.mjs` 使用 `LCA_RELEASE_DIR` 的候选回执和 `LCA_BASELINE_INSTALLER` 指定的固定 1.1.0 安装器，在独立目录真实安装、覆盖升级、冷启和恢复旧版存档；聊天只连接本地合成接口。安装器会处理同名运行进程，安装检查必须与所有包内 EXE 测试串行；发现已有安装或运行中的同名应用时拒绝。临时目录须有至少 3 GiB 可用空间，退出码不替代包文件哈希和状态核对。

升级检查还会在旧运行时关闭后写入合成的既有 profile 配置，核对候选启动及新回合后，manifest 用户字段、既有依赖与 bundle 声明、Cordis patch 和 workspace 配置均保留。卸载后等待注册状态收敛；没有确定结果时保留 `needs-reconciliation`，不重复卸载。

`node scripts/smoke-real-collaboration.mjs` 为单独授权的三场景真实探针，需 `LCA_REAL_MODEL=1` 和获授权的 `LCA_PROVIDERS_FILE`。只由 Electron 主进程提取既有 chat/work 槽位，保留工作路由与两项思考强度；独立数据根，默认 48 万预留单位、零自主预算、12 分钟总时限。另获明确额度授权时可设置 `LCA_REAL_MODEL_BUDGET_UNITS`，该参数本身不构成授权，不自动扩额或重试。出现需要用户回答的问题或审批就停止，不自动批准。结果记录实际成员模式、完成状态、普通最终回复、续用身份、用量及包身份；触及预算不能换新数据根自动重跑，失败也不能以任务板完成替代最终交付。容量满额仍由合成回归证明。`--preflight` 仅核对启动与配置接入，不发送任务；它不是实际模型质量验收。

每次发布核对源码 revision、trackedDirty、构建回执、安装器哈希与该包结果。第二机、真实账号和长期日用另行记录。v0.1.10 的历史证据见 [版本记录](releases/0.1.10.md)，不自动代表当前 main 已重新验收。

确定性研究脚本及其局限见 [研究索引](research/README.md)。

# 测试与验证

按改动选择检查，分别报告静态、合成流程、真实服务和实际使用的证据。完整脚本以 [package.json](../package.json) 为准，`pnpm run` 可查看当前列表。

## 日常检查

```powershell
pnpm typecheck
pnpm lint
pnpm test
```

纯文档改动检查链接、命令、一致性和 `git diff --check`，无需为文案重跑所有 Electron 场景。代码改动先跑相关单测与场景，扩大检查须有具体原因。

## 主要场景

| 命令 | 核验重点 |
| --- | --- |
| `test:electron`、`probe:sqlite`、`probe:journal` | 原生模块、受限 IPC、日志和重启 |
| `test:harness`、`test:failure-narrator`、`test:questions` | 工具回合、取消、失败与有界询问 |
| `test:developer` | 开发者 profile、调试 MCP、脚本模型经本地接口跑在 DSH 上、场景导出与展位拒绝 |
| `test:providers`、`test:model-slots`、`test:model-routing` | 配置、热路由、隔离、上下文、候选和重启 |
| `test:documents`、`test:campus` | 文件解析、原文边界、版本确认与真实本地交付 |
| `test:plugins`、`test:mcp`、`test:student-hub`、`test:student-hub-candidates` | 安装、指纹、工具白名单与兼容入口 |
| `test:memory`、`test:history`、`test:optical` | 来源、摘要、旧页、可选光学守卫和恢复 |
| `test:pomodoro`、`test:mini`、`test:resources` | 计时、双窗口、显示器边界与资源准入 |
| `test:dsh-bridge` | 真实 DSH 运行时 + 本地脚本模型：引用随开场消息、下一轮退役（含重启后）；第三方结果降级本轮、下一轮退役（含重启后）；聊天与工作模型交接、思考档位、自主额度、事件步数上限、项目信任 |
| `test:dsh-family` | 1.2 P2：临时项目／HOME／profile、本机脚本模型；真实 DSH + 生产 bridge 的成员审批、撤销、闲置主角色、多层委派、跨项目拒绝、迟到消息、摘要与冷恢复，原 14 场景，加 P3 的 `spawn-manager` 权限绕过回归，共 15 场景。fixture 不代改权限或退役内容；合成证据边界见 [P2 回执](research/v1.2-p2-20261023.md)。原反例保留在 [P0 / P1 回执](research/v1.2-p0-p1-20261023.md)对应提交 |
| `test:dsh-extensions` | P3：隔离 HOME / profile / 本地合成 bundle，生产 main 服务和 bridge、Electron Node 模式与随附 pnpm；PATH 排除系统 Node / pnpm。完整生命周期、独立脚本批准、运行中取消、丢失 IPC 回执冷恢复、核心保护与加载失败状态。不是页面或安装升级验收，见 [P3 回执](research/v1.2-p3-20261023.md) |
| `test:extensions` | P4：隔离 Electron 书页、原生选择的合成目录与逐次审批；本地 bundle 安装 / 启停 / 重启 / 移除、独立构建批准、丢失回执后同 ID 核对，Markdown 技能导入 / 优先级 / 修改删除 / 跨项目 / 冷启，以及实际 DSH 技能与 MCP 调用。仅本机合成模型与服务，截图和回执写到 `test-results/p4-*`，见 [P4 回执](research/v1.2-p4-20261023.md) |
| `test:dsh-collaboration` | P5：固定 DSH 的普通委派 / Team 共存、单一控制路由、成员关系、任务 revision / 依赖 / 范围提示、持久来源退役、两类容量、失败占位、断连回执、冷恢复及整组自主额度；Electron Node 模式，隔离 HOME / profile，PATH 排除系统 Node / pnpm |
| `test:collaboration` | P5：实际书页中的成员和任务、消息、单成员停止、整组停止、断连后刷新核对同一操作、冷恢复及窄窗口；只用本机脚本模型。复用已构建产物可运行 `node scripts/smoke-collaboration.mjs`；设置 `LCA_TEST_EXECUTABLE` 可指定包内 EXE。证据在 `test-results/p5-*`，见 [P5 回执](research/v1.2-p5-20261024.md) |
| `test:life-port`、`test:life-work`、`test:sleep`、`test:room` | 生活状态、实际产物、日记与重启 |
| `test:gifts`、`test:backup`、`test:characters` | 礼物同意、存档与角色作用域 |
| `test:package --unpacked-only` | 构建回执、包内 EXE 和独立测试数据 |

表中省略 `pnpm` 前缀。多数 Electron 脚本自带 build；复用构建或指定安装 EXE 时先读对应脚本，不能随意绕过前置检查。

开发者场景的脚本回复由本地模型接口交给 DSH：脚本里不带 `lca_` 前缀的 LCA 工具名会按 DSH 提供的名字发出；`get_context` 是 DSH 最近一次发给模型的请求。她的回合比旧循环慢一点：脚本要等模型请求真正到达（看 `get_context`）再拨时钟，她说话时被拒绝的命令（如导出存档）用 `whenIdle` 重发。

1.1 移除了旧心流、书桌命令、预览电脑、网页读取、分身和任务对象，以及它们的脚本（`test:heart-flow`、`test:task-object`、`test:timeline-safety` 等）与审计探针 `probe-context-continuity`；历史结果留在 git 记录和 [研究记录](research/) 里。旧心流的会话仍可在设置里查阅状态与差异，`test:room` 覆盖。

测试窗口默认透明并使用 `showInactive`，不抢焦点；需要目视验收时设置 `LCA_TEST_SILENT=0`。不另装 Playwright 浏览器。开发与测试使用合成来源和独立 profile，不借参考项目的真实数据填样例。

## 真实服务与资源

真实请求必须属于当前获授权任务，配置可用不等于授权调用。普通文档、单测或合成回归不会自动升级成以下探针：

- `test:real-model` 要求显式 `LCA_REAL_MODEL=1` 与授权 providers 文件；检查流式、工具往返、普通 UI 与 `probe:cache-live` 缓存 usage 对账，结果不打印正文或密钥。
- `probe:cache-live`（M1 缓存观测）使用合成提示词与独立临时 profile，最多 6 次调用 / 20,000 输入 token / 90 秒单次超时；报告只含数字、布尔与槽位别名，验证供应商原始 usage 与 `model/attempt`、重启后 journal 三方一致。`LCA_CACHE_PROBE_PAIR_SLOTS` 可指定做相同前缀两次的槽位，`LCA_CACHE_PROBE_REPORT` 写本地证据。两种供应商形状已于 2026-10-19 用授权端点完成真实 payload 验证；换端点后重跑即可复验。
- `probe:privacy` / `probe:model` / `probe:harness` 可能调用已配置模型。`probe:harness` 用真实模型跑一个 DSH 回合并调用一次 LCA 时钟工具。失败不回退 fake，真实质量与连通分别评价。
- `probe:student-hub-live` 要求显式 `LCA_STUDENT_HUB_LIVE=1`，使用临时库的只读邮件范围；不扩大到课程提交或外部写入。
- `probe:imap` 读取获授权文件夹；`probe:rodin` 会提交真实生成任务并可能收费。旧任务的预算不作为新任务的通行证。
- `test:pomodoro:realtime` 使用真实时间，区别于冻结或加速时钟。

## 安装与发布

`test:package --unpacked-only` 不安装 / 卸载，不能称为安装器升级验收。默认 `test:package` 发现已有同名用户安装会拒绝，不覆盖用户实例。

每次发布核对源码 revision、trackedDirty、构建回执、安装器哈希与该包结果。第二机、真实账号和长期日用另行记录。v0.1.10 的历史证据见 [版本记录](releases/0.1.10.md)，不自动代表当前 main 已重新验收。

确定性研究脚本及其局限见 [研究索引](research/README.md)。

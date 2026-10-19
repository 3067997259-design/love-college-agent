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
| `test:providers`、`test:model-slots`、`test:model-routing` | 配置、热路由、隔离、上下文、候选和重启 |
| `test:documents`、`test:campus` | 文件解析、原文边界、版本确认与真实本地交付 |
| `test:plugins`、`test:mcp`、`test:student-hub`、`test:student-hub-candidates` | 安装、指纹、工具白名单与兼容入口 |
| `test:memory`、`test:history`、`test:optical` | 来源、摘要、旧页、可选光学守卫和恢复 |
| `test:pomodoro`、`test:mini`、`test:resources` | 计时、双窗口、显示器边界与资源准入 |
| `test:heart-flow`、`test:desk-command`、`test:flow-rewind` | 工作范围、逐次审批、版本和撤销 |
| `probe:desk-command:runtime` | Windows 原生进程、网络 / 文件拒绝、编码、上限与取消 |
| `test:life-port`、`test:life-work`、`test:sleep`、`test:room` | 生活状态、实际产物、日记与重启 |
| `test:gifts`、`test:backup`、`test:characters` | 礼物同意、存档与角色作用域 |
| `test:package --unpacked-only` | 构建回执、包内 EXE 和独立测试数据 |

表中省略 `pnpm` 前缀。多数 Electron 脚本自带 build；复用构建或指定安装 EXE 时先读对应脚本，不能随意绕过前置检查。

测试窗口默认透明并使用 `showInactive`，不抢焦点；需要目视验收时设置 `LCA_TEST_SILENT=0`。不另装 Playwright 浏览器。开发与测试使用合成来源和独立 profile，不借参考项目的真实数据填样例。

## 真实服务与资源

真实请求必须属于当前获授权任务，配置可用不等于授权调用。普通文档、单测或合成回归不会自动升级成以下探针：

- `test:real-model` 要求显式 `LCA_REAL_MODEL=1` 与授权 providers 文件；检查流式、工具往返、普通 UI 与 `probe:cache-live` 缓存 usage 对账，结果不打印正文或密钥。
- `probe:cache-live`（M1 缓存观测）使用合成提示词与独立临时 profile，最多 6 次调用 / 20,000 输入 token / 90 秒单次超时；报告只含数字、布尔与槽位别名，验证供应商原始 usage 与 `model/attempt`、重启后 journal 三方一致。`LCA_CACHE_PROBE_PAIR_SLOTS` 可指定做相同前缀两次的槽位，`LCA_CACHE_PROBE_REPORT` 写本地证据。两种供应商形状已于 2026-10-19 用授权端点完成真实 payload 验证；换端点后重跑即可复验。
- `probe:baseline-flow`（D0 基线）要求显式 `LCA_REAL_MODEL=1` 与授权 providers 文件；固定剧本跑一次现有心流（进入、批准计划、一条 `desk_write` 工作消息、退出），报告只含 token 数、请求哈希与枚举，临时 profile 用完删除。
- `probe:privacy` / `probe:model` / `probe:harness` 可能调用已配置模型。失败不回退 fake，真实质量与连通分别评价。
- `probe:student-hub-live` 要求显式 `LCA_STUDENT_HUB_LIVE=1`，使用临时库的只读邮件范围；不扩大到课程提交或外部写入。
- `probe:imap` 读取获授权文件夹；`probe:rodin` 会提交真实生成任务并可能收费。旧任务的预算不作为新任务的通行证。
- `test:pomodoro:realtime` 使用真实时间，区别于冻结或加速时钟。

## 安装与发布

`test:package --unpacked-only` 不安装 / 卸载，不能称为安装器升级验收。默认 `test:package` 发现已有同名用户安装会拒绝，不覆盖用户实例。

每次发布核对源码 revision、trackedDirty、构建回执、安装器哈希与该包结果。第二机、真实账号和长期日用另行记录。v0.1.10 的历史证据见 [版本记录](releases/0.1.10.md)，不自动代表当前 main 已重新验收。

确定性研究脚本及其局限见 [研究索引](research/README.md)。

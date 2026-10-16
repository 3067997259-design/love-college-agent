# 新手流程主进程与 Claude 接口交接

2026-10-16。接口 **`c5c8b42`**（`接口：定义新手流程档案、完成状态与重新初始化命令`）已先合 main `9239ca2`。

## 接线位置

契约在 `src/shared/state.ts`、`commands.ts`、`README.md`。Claude 的 `book/Stage.tsx` 请以 `snapshot.onboarding?.status === 'needed'` 打开向导，完成后回书本；浏览器 `?onboarding` 可继续作为纯预览入口。真实主进程始终提供该字段，省略只用于旧 fixture。

`OnboardingPage.tsx` 在名字步骤发 `onboarding.profile { userName }`，称呼步骤发 `onboarding.profile { characterName }`；成功后再进入下一步。重新进入时从快照预填，不能只保存在 useState 里。最后发 `onboarding.complete`，以成功快照为准退出；初始“我已经有一本书了”保留现有 backup.import → 明确确认 → backup.restore，成功重启后直接书本和恢复晕染，不重复向导。`ToolsPanel` 已提供主进程侧“重新初始化”按钮，发 `onboarding.reset`；展位禁用。

## 数据与边界

- 新 profile：needed、userName=null、characterName="桃子"、completedAtMs=null。展位始终投影 completed，主进程拒绝 reset。
- 名字上限 20、称呼上限 12 个 Unicode code points；主进程拒绝换行、控制／方向控制字符和未知字段。trim 后空白分别清为 null／默认桃子，只改提供的字段。至少提供一项；非法输入不落事实。
- 三条命令只接受书本主 frame，权限检查先于 requestId 去重，迷你／诊断窗不能借已接受的 id 重放。
- 追加 `onboarding/state`，由 SQLite 会话投影重建；`session/carry` 传到下一天，按 user＋character 作用域隔离。complete 用统一时钟，重复完成不改原时间。reset 只清完成标记，不删除名字、聊天、记忆、交付或配置。
- `src/main/onboarding/prompts.json` 为独立提示词文本，供 Claude 审阅；代码只填经过校验的 JSON 数据。角色称呼与“关于你”分别注入 system 层，userName 不进入角色层。这些层不在 eligibleIndexes，配置事件也不进入对话／inbox／经历；每轮按最新档案构建，旧压缩不覆盖新名字。
- 私人存档 manifest 带 onboarding；恢复后保留状态、名字和原完成时间。沿用已有安全备份、校验、确认与重启事务，不导出整份 settings 或凭据。旧版存档没有该字段时，按已存在的书本 completed 打开，完成时间不补造。

## 验收与复现

实际通过：`pnpm typecheck`、`pnpm lint`、`pnpm test`（32 个文件／150 项）；构建后串行通过 `node scripts/smoke-onboarding.mjs --backend-only`、`node scripts/smoke-harness.mjs`、`node scripts/smoke-backup.mjs`。

新增单测覆盖主进程校验、Unicode 边界、无效输入不落日志、名字／完成／跨日持久化、角色／用户隔离、展位、重置不丢历史、非书本权限，以及档案系统层不参与共同经历和不可信存档字段校验。

后端 Electron 使用正常模式和临时 profile、本机合成 HTTP，不读真实配置、不调真实模型：验证 needed／booth completed，未完成名字重启、完成重启、实际模型输入分层与记忆排除、实际 ZIP manifest、新空 profile 的原生文件选择与确认恢复。原有 harness／完整存档流程继续通过，含 SQLite、原文隔离、撤销／损坏拒绝、安全副本与计时重锚。

命令 `pnpm test:onboarding:backend` 会构建并运行上述主进程场景；`pnpm test:onboarding` 为完整按钮／输入框／动画结束／导入流程场景，**待 Claude 接快照开关与提交命令后运行，当前不宣称 UI 验收通过**。默认脚本不绕过向导；仅显式 `--backend-only` 可通过 IPC 独立验主进程。

没有重打安装包。全局记忆未修改；IMAP 仍 blocked，与本次流程无关。

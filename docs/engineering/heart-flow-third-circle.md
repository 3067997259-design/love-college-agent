# 第三圈心流：查阅与历史续做

2026-10-17。接口 `fac7ab1` 先合 main。本批补齐 `/status`、`/permissions`、`/diff`，带重点的 `/compact`，以及历次心流的查阅／续做；整圈其余项继续见 [第三圈台账](third-circle-ledger.md)。

## 行为和权限

`flow.inspect {section, flowId?}` 打开无 bridge／无 Node 的用户专用原生窗口；三个斜杠指令也调用它，不调用模型。状态给消息字符数、属于本次心流 turn 的实测 token（缺失为 null）、固定书桌范围与逐次审批。价格未知时 cost=null，不虚构 0，也不把提供商配置值发给渲染层。字符数是当前投影消息的 JSON 长度，不是供应商 tokenizer 或缓存命中统计。

`bridge.readHeartFlow({section,flowId?})` 是 Claude 可用的书本窗口专用读接口。diff 包含已实际应用的 before/after、当前文件是否仍匹配、是否撤回；最多 50 条、单字段 8000 字、总正文约 96000 字上限，截断明确标记。原文只从用户专用查阅取，不在 snapshot／调试 MCP／普通上下文／经历抽取中增加原文。未知或其他作用域 id 拒绝，迷你窗与诊断窗拒绝。

`flow.resume {flowId}` 只接已结束的本作用域心流，创建新 id，强制 plan 模式。沿用最初冻结前缀和旧成果的证据索引，提示重新用 desk 工具核对当前文件；不复制原始工具结果，不继承 pending／approved 执行。新的脚本仍逐次人工审批。朴素入口在右页／设置心流区“历次心流”。

`flow.compact {focus?}` 与 `/compact 一句话重点` 保留最多 500 字的用户重点，作为工作层数据写日志。证据索引按实际 flowId 选已应用变更，并对长文件名做总长度限制；跨日不再拿局部 seq 筛昨天的工作。空 `/undo` 明确拒绝，不再回“接受”却不做事。

恢复执行状态也按整个 scoped 日志的实际顺序找同 id 的最后记录；昨天高 seq 请求、今天低 seq 完成的运行不会被错误追加 interrupted。原生 SQLite 探针已构造这个跨日案例。

## 实际验收

- 类型检查、lint、45 文件／218 项单测通过，心流新增 3 项，覆盖实际用量／排除旁路任务、原文 diff／外部修改／上限、旧会话续做／过期审批、斜杠路由与权限。
- `probe:heart-flow` 原生 Electron／SQLite 通过，增加跨日 completed 不被误标 interrupted 的断言。
- 更新后的 `test:heart-flow` 场景实际验证三个原生查阅窗口、用户 diff 读、mini 拒绝、历史查阅、恢复为新 plan 和 compact 重点；保留原工具写入／审批／执行／撤回／重启验证，模型为 fake。
- 基础 Electron、私人存档、历史照片／引用回忆回归通过；新 preload 方法加入实际白名单枚举检查。

尚未把 `/init`、`/review`、`/goal`、子代理、Git 影子提交、web_fetch 或系统命令冒充完成。现有明确权限仍是 desk-only、JavaScript 隔离运行、每次审批；不能拿 cwd 当 OS 沙箱。下一批先做只读分身和剩余心流能力，再继续全圈其他条目。

2026-10-17 后续接口：`FlowGoalView` 和 heartFlow.goals/goalId、flow.goal.set/select/status 先独立合 main。目标按用户和角色跨日／跨次心流保存，只由用户命令编辑或标记状态；completed 明确是用户标记，不是模型的外部执行证据。接口这一步尚未代表后端或 UI 已实现；/init、/review 后续单独接。

## 跨次工作目标（659dd82 接口）

目标现已接 append-only 投影、朴素设置入口和 `/goal 一句话`。可以在心流外设置；斜杠更新当前仍活动的目标，没有时新建。界面可新建、选择、编辑、用户标记完成／取消或重新打开；文字最多 200 UTF-16 单元、单行且通过固定隐私遮盖一致性检查。空 `/goal` 和超长值拒绝。目标文本是工作数据，只加在冻结前缀之后，不流入普通聊天／经历。模型只提供只读 `get_flow_goals`，没有完成或改写目标的工具。

进入／续做时记录所选活动目标与新 flowId 的关联，不继承旧的脚本审批；展示最近 20 个目标（包含当前所选）、每个最近 50 次关联。用户换目标会取消现有子任务与待批／正在运行的隔离脚本，下一次模型输入读取新目标。用户状态标记保存在自己的日志，不把它当作实际执行或成果证明。

本轮类型／lint、50 文件／271 项单测通过；原生 Electron／SQLite 探针实际跨日关闭重开并跨两次心流保留目标、只读目标工具、用户状态、角色隔离。`smoke-heart-flow.mjs` 实际通过界面创建、两次关联、重启保留和用户点完成后重启；`smoke-backup.mjs` 验证同 profile 和空白 profile 私人恢复保留目标及 user 确认归属。模型与数据均为合成；没有真实模型请求。

后续接口先行：flow.init／flow.review 和 flow.operation.open、heartFlow.operations 元数据。任务限已批准的 execute 心流，目标为实际书桌草稿；ready 只指文件已产出，不指“审查通过”或“测试通过”。正文只在书桌／心流上下文和原生用户预览，不进入普通记忆。后端和验收待接，不能仅凭接口宣称已实现。

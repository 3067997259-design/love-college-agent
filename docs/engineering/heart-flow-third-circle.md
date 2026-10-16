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

## 项目说明与改动审查草稿（7634e52 接口）

flow.init／flow.review（或 `/init`、`/review`）复用真正的主 harness，仅在已批准 execute 的心流发起。代码冻结最多 8 个来源、UTF-8 总 24 KB 的索引；`/init` 读取书桌文字，排除既有工作草稿，实际 desk_read 留下元数据证据。`/review` 只取本次 flow 已实际应用、当前版本仍匹配的 before/after，包含删除；遗漏数量随操作显示。两者均只能写独立的 `工作草稿/<UUID>.md`，禁止修改源文件或申请脚本运行，不把 cwd 当系统沙箱。

ready 要求回合 completed、来源没变、有相应读取／成功模型输入证明、desk/change 已 applied、当前真实文件与输出字节匹配。只说“完成”、未读取输入、外部修改、迟到工具调用均不会记 ready。ready 只指实际未审核草稿，不指审查／测试通过；最终判断仍由用户核对。正文只在书桌／工作上下文和无 bridge 的原生用户预览，不进快照、普通上下文或经历抽取。元数据有来源／遗漏数、时间、相对路径、哈希／字节数和明确错误。

停止、熄灯、用户换目标或新插话会取消草稿和其模型调用；忽略取消的迟到返回不能写文件。重启将 running 记 interrupted，不重放；产物被外部改动转 failed 并保留用户修改。已保存草稿随 desk 日志快照恢复。朴素入口在心流工具区，Claude 可根据 operations 绘制活动状态并用 operation.open 查阅。

实际验收：类型／lint、51 文件 286 项单测通过（新增 9 项草稿边界）；`node scripts/smoke-flow-drafts.mjs` 使用真实 Electron／SQLite／文件／原生预览，覆盖计划拒绝、实际说明／审查、只声称完成失败、取消、重启、私人存档恢复、普通上下文隔离和外部修改保留。模型和材料均为 fake／合成，没有真实模型调用。原有心流与基础 Electron 回归另跑；当前安装包仍未包含本批。命令 `pnpm test:flow-drafts`。

## 独立 Git 影子证据（ed1dad0 接口）

书桌根有正常 `.git` 目录时，每项已应用写入／删除／撤回在 profile 内独立 bare 仓库生成一对 before/after 提交，只包含本步修改文件；未管理文件不在树里，不声称全项目快照。committed 和 SHA 来自真实 Git 返回，用户 diff 可查；非仓库、重定向 `.git`、Git 缺失或失败明确降级，不撤销已经写成的文件。日志 prepared/applied 和原始 before/after 仍是恢复与版本匹配撤回的依据，Git 不执行撤销副作用。

Git 只在独立副本运行固定 plumbing 和 stdin，参数不进 shell，不在用户原仓库执行，隔离全局／系统配置、模板、hooks、fsmonitor 和自动维护。不读原仓库配置，不动其 HEAD／refs／索引。路径检查拒绝链接重定向；本机原生验收暴露长路径后只为本调用设置 core.longpaths，不改全局。单进程十秒上限，错误内容不返回用户或诊断。工作树指针 `.git` 文件暂不跟随，显式 unavailable。

私人存档只带权威日志，不打包 Git 元数据或用户 hooks。恢复或本机副本丢失时，按日志原时间重建已有影子对象，并核对原 SHA；这属于投影恢复，不执行模型、不重放代码、不声称离线工作。Git 仍不可用时用户查阅显示 unavailable，保留历史记录。普通上下文、记忆和房间运行记录没有新增原文。

五项真实 Git 单测、原生 `node scripts/smoke-desk-shadow.mjs` 已通过：中文／逗号路径、写入／删除／撤回、原 HEAD/config/index/hooks 不变、非仓库和缺失 Git 降级、链接拒绝、日志副本丢失和实际私人恢复后同 SHA。模型／材料为 fake／合成；未打新安装包。命令 `pnpm test:desk-shadow`。

合并前完整类型／lint、53 文件／301 项单测通过。原生验收同时覆盖此前短临时目录单测未暴露的 Windows 长路径，不以单测通过代替 Electron 落盘证据。

后续 #25：审查来源按路径取本次 flow 最初 before 到最终 after 的净差异，不再只审最后一次写入。完全撤回无净变化，中间外部编辑用标记说明。手动／自动压缩、多次写入、删除重建和撤回组合单测及 Electron 真正两次写入后压缩／审查的成功输入核验已通过，源哈希与实物校验不变。

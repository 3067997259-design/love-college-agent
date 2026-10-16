# 界面接口 v0

此目录是两条编码线唯一共用的契约入口，不依赖 Electron、Node 或主进程模块。

- `state.ts`：安全快照、时钟、角色状态、任务、消息、活动、候选与交付卡。
- `commands.ts`：白名单命令与回执。accepted 只表示接收；完成必须看后续快照里的任务终态。
- `events.ts`：先用完整快照事件，状态归主进程所有，避免前端再维护业务 reducer。水位与原始 journal seq 分开。
- `bridge.ts`：真 preload 与假适配共同实现 `getSnapshot / subscribe / dispatch / readEvidence`；全局入口为 `window.lca`。

接线先订阅并缓冲，再获取快照。丢弃同代次中 revision 不高于快照的事件；断线、缺口或 epoch 改变时重新取快照，清掉旧代次的缓冲与请求。订阅卸载时必须退订。

首版字段均为可序列化数据。槽位名交给角色包回退；文件用 artifactId，不允许渲染层传任意路径。候选证据单独通过受限的用户查阅接口读取，不进通用快照，也不能复用到模型上下文。禁止在此添加密钥、配置原文、工具原始结果、异常原文或隐私模型输入。

未实现的命令由主进程明确拒绝；capabilities 的 fake 状态只能用于明确标记的开发场景，不代表真实调用通过。新增字段由 GPT 单独提交接口，Claude 合入后再消费。

2026-10-16 Claude 审阅补充：

- 已知表情由 `EXPRESSION_IDS` 导出，默认 `DEFAULT_EXPRESSION = calm`；姿势由 `POSE_IDS` 导出。快照仍用 string，允许角色包缺素材回退。
- `companion.daypart` 只由主进程计算；当前默认 06/12/17/20 时分段，可由主进程作息所有者提供另一组边界，界面不自行推时段。完整作息调度尚未实现。
- 消息与候选、交付卡按 `createdAtMs` 排序。首次快照、重启和恢复只挂载已有卡片，不重播入场；后续新 id 才入场，不能只靠“时间很近”判断。
- `sourceLabel` 必须由采集层校验成短字段，不能直接塞原始邮件主题。`mailboxUnseen` 只有 mail capability 为 ready 时才有效，连接失败不能显示成“0 封新邮件”。
- `readEvidence` 是用户查阅通道，按主进程的用户／角色作用域查 opaque ref；不存在或未接入时明确拒绝。返回值不可进入快照、展示事件或模型上下文。高亮是 excerpt 的 UTF-16 半开区间，对应字段名 `deadlineIso / eventStartIso / locationText / title`。
- 番茄钟空闲时 `phaseDurationMs`、`plannedCount` 均为 0；运行时由主进程提供本段总时长与这一轮计划数量。

执行底座补充：`PUBLIC_ERROR_CODES` 导出统一枚举，新增模型配置、上游繁忙、额度、断流、非法输出，以及步数／重复调用／预算上限。任务失败看 `task.error.code`，不要把这些失败展示成工作完成；错误里仍只有固定分类与 opaque detailsId，不含供应商报错或配置值。

第零圈补充：`runtime` 为可选安全视图，包含插件状态、权限类别和开发模式状态，不包含路径、代码、配置值或调试令牌。旧假场景可以暂时省略；真实主进程提供它。启用代码插件必须提交当前 fingerprint，变更后重新确认。开发模式在独立测试数据中运行且不加载真实供应商，展位模式拒绝开启。

番茄计划由 `pomodoro.plan` 提议、`pomodoro.confirm` 用户确认、`pomodoro.start` 开始；模型不能代替用户确认。`pomodoro.resume` 仅继续暂停的当前阶段；下一个专注仍需 start。`plan.timing=demo` 必须在界面明确标注。新入口未接通前仍由主进程拒绝，不给占位成功。
# 邮箱与候选确认（第一圈）

`AppSnapshot.mailbox` 只含来源、健康状态和计数；`unseenCount: null` 表示未能观察，不能当作没有邮件。开发邮件、候选和交付均标记 `source: fake`。`mail.scan` 只启动扫描，不确认事项。正常 IMAP 仍为 blocked，不会因开发场景而变为可用。

真实候选包含递增 `revision`；`candidate.confirm`／`candidate.ignore` 必须携带画面上的 `expectedRevision`，省略或过期均拒绝。确认可另外提交用户计划完成时间，绝不改写原始截止时间。变更卡通过 `change` 保留旧时间和旧证据入口，活动可提供结束时间；原文仍只走 `readEvidence`，不进快照、事件、模型上下文或调试上下文。

确认与本地交付分开：`campus.export` 仅导出新确认／重新确认的版本，生成日历与 Markdown 交付卡。改期沿用 UID 并递增 SEQUENCE。导出文件不代表写入任何外部日历。`developer.mailbox` 只在独立开发 profile 切换合成场景（初始、改期、恶意、滤芯失败、空邮箱）。邮箱固定走隔离路径的隐私标记显示 `privacyLocked`，不允许设置页悄悄关闭。


## 附件与文件处理

`documents` 只包含通用文件标签、来源类型、进度、页数和经代码校验的截止时间；原文、源路径、真实文件名和整理成品均不进入快照或模型上下文。`document.attachment` 按 opaque id 暂存邮件附件；`importFiles(File[], epoch)` 仅供用户拖入／选择，preload 用 native File 解析路径并直接传主进程。没有接受任意路径的公共命令。

`/privacy` 是本地控制指令，等同 `privacy.set`，不发给模型；开关在设置中持久化。当前仅实现隔离整理：关闭时暂存，开启且隔离依赖可用时处理；关闭、熄灯或取消停止在途处理，失败不回退主模型。完成后只给用户交付卡，模型最多收到通用文件名、类型、页数和校验过的截止时间。

`document.retry/cancel` 控制资料任务。`developer.documents` 和 `developer.document.import` 仅在独立开发 profile 提供合成 fixture／故障场景，不代表真实模型、真实附件或 IMAP 已接通。旧 UI fixture 可以省略新视图和导入方法；真实 preload 提供它们。

## 记忆、日会话与压缩

`memory` 提供当前后台状态、计数和最多一小页未审核记忆；记忆只能来自实际模型输入记录，不能扫描证据库、文件库或交付成品。`session` 提供当前上海时间 04:00 起算的日键、待翻页状态和已有页元数据。`readSession(sessionId)` 只给用户看历史聊天，不返回工具原文或执行日志，也不注入模型。

`memory.extract`、`context.compact` 分别请求批量抽取和完整旧回合压缩；压缩只改模型投影，用户聊天原文保留。`/compact` 是同一项本地控制，不发送给聊天模型。`session.rollover` 也必须通过时间、回合空闲和熄灯检查，不能强行切掉执行中的回合。自动翻页与抽取遵守相同边界。

`developer.memory` 只切换独立开发 profile 的 fake 后台模型。normal 未接后台模型时显示 unconfigured，不暗中调用聊天模型。来源、作用域、纠正链和晋升由主进程维护；界面不自己推导它们。

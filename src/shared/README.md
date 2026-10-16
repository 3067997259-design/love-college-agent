# 界面接口 v0

`memory.summaryCounts` 提供有效日／周／月摘要数量；同一周期来源不变不重复调用。`memory.consolidate` 只归并已关闭周期的已有日摘要，不读取原始邮件或附件。晚到的来源追加新版本，旧记录保留；给模型的层级参考不重复覆盖同一来源会话，也不参与新的经历抽取。

第二圈礼物：`gifts` 是真实生成生命周期，和预制羽毛笔 quill 分开。gift.propose 必须绑定已见经历；物件和装饰取共享枚举，发往 Rodin 的描述由代码映射，不发送姓名、邮件或记忆原文。专注开始制作，工具取得并校验本地 GLB 后才 ready，休息才 given；取消停止本地后续处理，不承诺上游撤单或退款。每天最多一次提交，失败也占提交预算。assetUrl 仅本地受限资源，未配置时 configured=false，不能假装开始了。上游凭据、任务订阅 key 与签名下载 URL 永不进快照、日志或调试接口。

此目录是两条编码线唯一共用的契约入口，不依赖 Electron、Node 或主进程模块。

新手流程：真实快照提供 `onboarding`（旧 fixture 可省略）。新 profile 为 needed，userName=null、characterName="桃子"、completedAtMs=null；booth 始终投影 completed。正式界面据 status 决定是否显示向导，不从查询参数或本地存储决定入口。

`onboarding.profile` 只修改提供的名字字段：userName 最多 20 个 Unicode code points，characterName 最多 12 个；拒绝换行／控制字符，trim 后空白分别设为 null／桃子；至少提供一项。不改变完成状态，写后重启仍在。`onboarding.complete` 标为 completed，用统一时钟记录 completedAtMs，重复完成保留原时间。`onboarding.reset` 清完成标记并重新进入向导，保留名字、聊天和业务数据；展位拒绝 reset。三条命令只能由书本主窗口发送。

characterName 进入角色的系统称呼，userName 进入用户档案的“关于你”；二者都是用户配置，不是共同经历，不从配置事件生成聊天或记忆。私人存档携带以上字段，恢复已完成存档直接回书本。开头的“我已经有一本书了”复用 backup.import → awaiting-confirmation → backup.restore，不把选中文件当恢复成功。

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
- 阶段空闲时 `phaseDurationMs` 为 0；`plannedCount` 是当前生效计划的当天总数，没有生效计划才为 0，待确认草案不改变它。主进程提供本段时长、当天总数和完成数，界面不从草案重新起算。

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

## 第一圈收尾：MCP 与私人存档

`mcp.configure` 打开原生文件选择器导入标准 mcpServers 配置；配置、启动参数、地址、环境变量和令牌只在主进程。`mcp` 只给服务器 id、传输类型、来源、状态、隐私标记、允许的工具名和配置 fingerprint。连接需要用户确认当前 fingerprint，再由主进程原生对话框展示实际程序／参数／工作目录或服务地址供用户核对，不把这些值传给页面。断开使迟到的确认失效，并立即取消在途调用；工具结果按隐私策略校验后才进入模型投影。

`backup.export/import` 使用主进程原生对话框；公共命令不接受文件路径。导入先校验并进入 awaiting-confirmation，界面显示 incoming 摘要；只有显式 backup.restore 携带当前 restoreId 才备份现有数据并恢复。`restored` 表示实际恢复完成，动画不能仅根据选中文件播放成功效果。路径、凭据和存档字节不进入快照、事件或调试 MCP。

`quill` 表示首件有工具证据的工作关联的羽毛笔，state=given 后提供书本里的存档入口；未收到时设置页仍可导出。它是预制礼物，不能说成实时 Rodin 生成。

`readDiagnostics()` 仅在真实开发模式开放，正常／展位模式拒绝。它读取模型可见投影、有限回合统计、inbox 元数据、调度队列和记忆分数，不返回配置、原始工具输出、邮件或附件。未采集的首字延迟、缓存 token 和费用为 null，界面不能当作零。隐私原文对照仍走单独的用户查阅入口，不进入通用诊断或模型上下文。

`models.configure` 通过原生对话框导入本机 providers JSON，凭据不经过页面。`modelSettings` 仅含已装配的槽位名、保存状态和需要重启的标记，没有模型名、URL 或密钥。开发 profile 拒绝导入真实配置。设置保存不代表连通验证通过。

`window.mini` 收起书本；`window.expand` 回到书本并销毁小窗，旧 `window.book` 兼容同一行为，不改变计时和任务。迷你渲染入口为 ?view=mini；`window.mini.hover` 携带 `over: boolean`，hover/move 只接受迷你窗口的主 frame，不能由书本伪造。主进程设置置顶和鼠标穿透，透明异常时回退不透明圆角窗；可选的 miniPresentation／miniFallbackReason 仅说明本机显示模式，不含 GPU 或配置细节。主进程夹住拖动坐标、保存 profile 位置。开始新一段专注收起一次；短／长休息、停止和熄灯保留当前窗口，不抢焦点；熄灯暂停计时／后台，点她仍可回书本。重启从书本开始，不自动复原上次小窗。

`PomodoroPlanInput.items` 可省略；提供时每条为 `{ text, count, assist }`，text 是非空单行短文本（最多 40 Unicode code points），count 为正整数，全部 count 之和必须等于 plannedCount，assist 为必填布尔。工具 plan_pomodoros 使用同一校验，非法输入不写日志、不创建计划。PomodoroPlanView 保留通过校验的原始条目，不补造条目或改变 assist。

计划条目与草案的完整契约（取代早期的 plan.status=proposed 接法）：`pomodoro.plan`／plan_pomodoros 只写 `pomodoro.proposal`，草案只能是 proposed；`pomodoro.plan` 字段只放 confirmed／finished 的生效计划。提议可发生在专注／休息／暂停／空闲中，已有草案就替换草案，不动生效计划、focusIndex、阶段、截止点或暂停原因。

迷你窗最新接线：`window.expand`（回书本并销毁小窗）、`window.mini.hover { over: boolean }`、`window.mini.moveBy { dx: integer, dy: integer }`。moveBy 使用物理屏幕像素，主进程按当前显示器 scaleFactor 换算为窗口 DIP，并在当前显示器 workArea 内夹限；渲染层每帧最多发送一次。CSS screenX/Y 的差值需先乘当前 devicePixelRatio（默认页面缩放为 1），再累积取整数，不能直接把 DIP 当物理像素。旧 window.book／window.mini.move 暂兼容，后者仍按 DIP。

主进程加载 `?view=mini`，新小窗为 280×350 DIP；首次在主屏工作区右下角留 24 DIP 边距。有位置偏好则按 profile 和显示器恢复，越界／显示器缺失归位；应用重启只开书本。`window.diagnostics.open` 仅开发模式开放独立诊断窗，normal／booth 拒绝；diagnosticsOpen 表示它是否存在。诊断窗只读安全快照和 readDiagnostics，不获文件／原文入口或业务命令权限。

`pomodoro.confirm(planId)` 只确认当前 proposal，任何阶段可确认；plannedCount 是今天的总数，包含已完成和正在进行的那个，少于 focusIndex 时拒绝。确认保留当前阶段、剩余时长、截止点、已完成进度，更新生效计划及总数，清 proposal；新时长从下一阶段使用。`pomodoro.discard(planId)` 只丢弃匹配的 proposal；`pomodoro.stop` 只结束生效计划，不再丢草案。完成数由主进程提供 completedCount（旧 fixture 可省略），正在进行／暂停的专注不计已完成；get_timer 返回它供模型排当天总数。渲染层不要从新草案重新起算进度。
# 心流

`heartFlow` 是书桌工作的安全投影。`flow.enter` 冻结前缀；`flow.mode` 切换只读计划／执行；`flow.compact` 仅压工作层；`flow.exit` 追加有证据的工作摘要。`flow.run` 申请执行 JavaScript，`flow.approve` 仅书本窗口能发，审批不持久复用；展位禁止运行。没有 shell／Node 权限。`flow.undo` 只撤回最新的匹配文件版本，追加事件，不删除历史。

# 世界泡

`life` 的出返、地点、拾取时刻和物品由主进程确定。`life.schedule` 是用户今天作息的明确输入；`life.propose` 仅提议，用户在时用 `life.depart` 同意出发，`life.return` 提前结束。离线事实带 offline=true，只结算最近三天的虚构外出；恢复私人存档直接校准 settledUntilMs，不补空档。桌面最多三件，其余入抽屉。素材缺失时界面用文字回退。

# 日记与房间

`diary` 只投影日期、锁状态和来源。`readDiary(id)` 是用户独占入口，主进程检查解锁后返回主观正文和既定钥匙；禁止喂回模型、记忆或调试 MCP。`diary.write` 尝试为已结束的一天写一次；已有篇章永不覆写。`room.open/rebuild` 只打开／重建程序自己的投影目录，不接受任意路径。正文为带密码 ZIP；运行记录只含类型、时间和成败。


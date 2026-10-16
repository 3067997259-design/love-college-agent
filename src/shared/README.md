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

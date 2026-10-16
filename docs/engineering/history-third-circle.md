# 历史照片与引用回忆：第三圈接口

共享接口位于 `src/shared/state.ts`、`src/shared/commands.ts`。先独立提交合 main，再实现主进程和朴素控件；Claude 负责书页画面。

- `snapshot.history`：照片索引、捕获状态和回忆状态；不包含历史摘录正文。`SessionPage.photo` 是该页保存的真实截图，`recallableMessageIds` 由主进程核对成功模型输入后给出。
- `history.photo.capture`：仅书本窗口，截当前场景层，不接受任意矩形、路径、URL 或图片数据。不截对话、钟、门牌及设置浮层。照片为 PNG 私人资产，随 `.lca-save` 带走；旧页不按今天的角色素材重画。
- `history.recall { anchor, question }`：仅书本窗口正常聊天空闲时。anchor 是 sessionId／messageId／原聊天文字的 UTF-16 半开区间；主进程验证范围与实际可见证据，正文不由渲染层提交。无法证明看见的片段拒绝回忆，不把用户可查档案当成模型可读档案。
- 回忆材料仅来自该作用域的成功 `model/seen` 允许片段；不打开邮件、附件、整理成品或日记，心流工作过程也不参与。历史参考不获得用户直述的事实修正权限，不重复抽取为新经历。
- 画面可用 `history.recall.status === 'recalling'` 表现正在回忆，并临时显示 `recall.photo`；状态与图片以主进程结果为准。具体动画和最终文案交 Claude。

当前为接口约定，运行验证待实现后补录。合成经历／fake 模型验收不等同真实模型质量或自然跨日运行。

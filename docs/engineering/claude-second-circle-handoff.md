# Claude 恢复额度后的交接

2026-10-17。本轮用户授权 GPT 审计并完成第二圈；Claude 预计 02:30 恢复五小时窗口。主进程和朴素接线已逐项合 main，已有美术／着色器／声音未重写。请在自己的 worktree 保留未提交工作，合 main 后先审 src/shared。

| 接口提交 | 范围 | 实际可接入口 |
| --- | --- | --- |
| `c5c8b42` | 新手档案／完成／重置 | 向导已绑定快照和表单，不再依赖 ?onboarding；它仅保留浏览器美术预览 |
| `3c1a78c` | 实时礼物 | snapshot.gifts、gift.propose/start/cancel/open；GiftControls 已用真实 model-viewer 展示本地 GLB |
| `06db36c` | 周月摘要计数／归并 | snapshot.memory.summaryCounts、memory.consolidate；最近七天仍留日摘要，单次引用上限 12（七日优先，余下给周／月） |
| `de59527` | 心流 | snapshot.heartFlow、flow.enter/exit/mode/compact/undo/run/approve；进入后右页直接出现工作列表与审批 |
| `c1aa31d` | 外出与物品 | snapshot.life；locationId=room/coast/swing，生活面板有作息、出发、提前返回和物品／抽屉文字回退 |
| `6040797` | 外出取消状态增补 | OutingView.status 新增 cancelled：跨日未出发提议失效，不生成物品或返回经历；只给 proposed 显示出发按钮 |
| `4721803` | 日记和房间 | snapshot.diary 元数据；bridge.readDiary 仅书本窗口用户可读解锁正文／钥匙，禁止转发模型 |
| `b609082` | 急件和提醒规则 | snapshot.notifications；模型仅提规则草案，设置页确认；普通系统通知只有两类 |
| `9d860b6` | 角色包 | snapshot.characterPack；静态 PNG 槽，缺图回退，重启切换独立关系作用域 |

先做有直接体验收益的接线：礼物架接 gifts（quill 保留首件意义）；外出小物点开来源并跳日记；下一页书签交钥匙；心流工作列表换成你掌握的右页样式。接口由 main 定事实，画面不自行推导时间、拾取、状态或计划确认。

声音线的缺口需要明确补：内置角色卡 persona 目前空，chat 只有称呼、关于你和执行／隐私等技术规则。请把她的人设和语气写成独立文本／JSON，用户把关后接入；不要覆盖技术规则。日记文本／做梦措辞也请审 prompts.json。正常日记用 chat 槽位独立调用、计自主预算，日摘要仍用 background；正文不接回聊天或经历。不要把 fake 示例 prose 当最终角色声音。

对照记录：progress-audit-20261017.md 及各 second-circle 工程记录。仍属最小版的部分：纯 JavaScript 执行（不支持 shell／Node／装包）、文件日志快照（无 Git 影子提交）、外出文字和物品目录（美术待接）、固定下一页书签解锁、角色包只接 PNG。read/write 生活安排无产物生成器时记 skipped，不假记完成。

下一波建议按价值排：完整角色声音和真实模型任务质量 → 历史左页照片／引用回忆 → 外景及生活产物 → 五分钟连续路演。完整心流指令、语音和更多场景按体验缺口选择；光学记忆、分身、MC、computer use 各有单独验收成本。用户尚未要求新增第四圈，不因速度快就自动扩张。

真实 IMAP 仍阻塞，学校 privacy URL 未到；滤芯缺失就关闭。Rodin 今晚已成功 1 次（32.3 秒，1.21 MB），用户总预算 3 次，余 2 次，不自动耗尽。角色包／日记／资料／礼物都带私人恢复边界；不要为方便接画面而让原文、钥匙或上游句柄进入快照／模型。

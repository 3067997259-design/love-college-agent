# 书桌心流：首个闭环

2026-10-17，接口 `de59527`。用户指定“仅书桌、运行逐次审批、展位禁用代码”。实现一个活动心流、冻结系统前缀和进入前对话参考、计划／执行、工作层压缩、文件快照／版本匹配撤回、退出时有证据的摘要。`/plan`、`/compact`、`/exit`、`/undo` 有对应控制；固定审批档由设置中的说明和每次弹框表达，不开放宽松权限。

编码插件独立实现 read/write/edit/find/grep 和 run_javascript，复用 update_plan；询问用户走原有聊天收件箱。运行目标刻意收窄为 JavaScript：隐藏的独立 Chromium renderer，sandbox=true、无 preload、无 IPC bridge、无 Node、独立非持久 session、网络／权限／导航／下载全拒绝，5 秒超时并终止卡死进程。它只计算并返回有限 JSON；书桌的读写由独立受限文件工具完成。任意 bash／PowerShell／Node 与包安装暂不支持，不能以 cwd 冒充系统沙箱。依据 [Electron sandbox 文档](https://www.electronjs.org/docs/latest/tutorial/sandbox)。没有借用参考工程代码。

写入先追加 before/after 快照，拒绝设备名、ADS、越界、软链接和硬链接。撤回只针对当前内容匹配的版本，避免覆盖用户后来编辑；不做 Git 影子提交，非 Git 书桌采用日志快照降级。私人恢复从日志重建受工具管理的文件；手工放入且未被工具修改的文件暂不在私人存档里。导出前须退出心流。原始工作过程 model/seen 全部不可用于经历抽取，退出摘要只含变更编号、路径、当前哈希匹配和运行成败。重启不复用待批／已批操作；保留心流供用户继续。

实际通过：typecheck、lint、3 项单测；`probe:heart-flow` 原生 Electron／SQLite 写入撤回、无 require/process/bridge、拒绝网络、死循环终止；`test:heart-flow` 实际工具写书桌、审批界面、沙箱返回、撤回、待批请求重启丢弃及退出。聊天模型为 fake。右页完整审美工作台、已有心流回看详情和 Git 仓库影子提交仍属后续完善，当前入口为工具与设置的朴素控制。

组合审计补强：执行代码移入独立 renderer 内的 worker，原生探针确认没有 window／DOM／RTCPeerConnection，进一步缩小可用网络 API；保留独立 CSP、session、OS sandbox 和 5 秒进程终止。心流入口在设置，进入后设置自动收起，工作列表／审批直接在右页；普通聊天和工作消息按日志位置分开投影。内置编码技能在 coding-skill.json，和规则／人设一起冻结。跨日上下文采用会话＋序号映射到总日志位置，避免新页局部序号与昨天碰撞。原生探针实际覆盖压缩后的跨日重启，普通对话中同文本的新消息也不会误删。写文件改成 prepared→applied/failed；只将已落盘的更改纳入撤回、摘要和恢复，启动核对悬挂写入。补一项磁盘失败单测，总计 4 项。

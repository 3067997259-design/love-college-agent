# MC 近身 survival 挖掘

2026-10-17 08:23。使用既有接口 37cb419 的 allowMining／mining feature／mine 动作种类，无新增公开协议。朴素控制默认关闭本轮挖掘，核对玩家后单独勾选。首批只处理泥土、草方块、石头、圆石，不开放容器、任意拆图或 instant；每轮最多四次尝试，继续计入原 24 次动作上限。

工具要求真实客户端报告 survival、站稳、无水、无飞行、无骑乘且未使用物品；目标在批准半径内、眼睛三格内、不是脚下／自身所在列的身体位置。先等导航结束，核对新准星正对给定坐标和 expectedBlockId；再用原生 evaluate_harvest 检查 held-tool 可采、精确预计不超过 40 tick、无危险／缺条件。只通过带本轮 controlSessionId／sequence／expectedWorldSessionId 的 break_block(mode=survival) 启动；管理员命令和 world_write 仍要求关闭。

启动回执不是成功。最多九次受限读回／350 ms 统一时钟间隔，共享 12 秒工具期限；每次复核玩家范围、世界、原生 input owner 和 mining 目标。只有新客户端目标为空气且自己的 mining.active=false，才记本次观察成功。返回 removedObserved／inputStopped，明确 breakAttributedToPilot=false、pickupVerified=false：多人可以同时挖，方块消失不能归因给她，也不能当作收到掉落物。背包仍须另读。卡住、目标变化、危险、未破坏或 owner 不匹配均停止整轮并按旧机制核验释放，不自动重放。

接口字段只参考本机 mcpfabric 的 tools.ts、ClientMc／InteractHandlers／MineHandlers／ControlHandlers／BotController 源码，独立实现，未修改、复制或运行参考工程。此处使用客户端新鲜 harvest／process 状态，不冒充服务端 break/drop 事务证据。

类型、lint、60 文件／388 项单测通过。新增十一项覆盖默认未授权、四次上限、真实新状态而非 ack、危险／工具不足／过慢／creative／脚下／远处／准星不匹配拒绝，以及统一时钟超时和原生 lease 释放。原有 MC 七步场景与图片 HTTP 场景再次通过。

`pnpm test:minecraft:mining` 已通过真实 Electron／SQLite／本机 MCP：默认不勾选→单轮同意→scene→mine→inventory→回复；核对实际 survival 请求、目标变 air、owned mining 已结束、背包仍只有原工具、未宣称拾取／因果归属、普通上下文排除、停止释放和重启不续玩。世界与模型均为自有合成 fixture，报告 test-results/minecraft-mining-report.json，不是实机验收。首次脚本的长固定回复标记被既有脱敏替换而超时；改用短标记并按实际工具 callId 关联结果后完整通过。旧安装包不含此批，新包清单已加场景。

MC 原要求的工具子集和 Markdown skill 现已有代码及合成原生证据；仍需展位可调预算／恢复不回退资源计数，以及 AIRI 测试配置所对应的双客户端上线实测。第三圈整体尚未完成。

# MC 游戏截图与独立图像上下文

2026-10-17 08:12。消费已先合 main 的 `37cb419`：`allowScreenshots` 默认 false，操作员每轮玩家／范围确认前单独勾选；批准的 MCP 工具必须含 screenshot 和 expectedWorldSessionId。公开快照／bridge 没有新增字段或方法。

普通 MCP 工具和文字协议仍拒绝 image。新增主进程内部固定 screenshot 二进制出口，遵守 allowTools、privacy=none、schema、连接世代、取消和期限。只接一个 PNG 图像与有界元数据，不把上游 base64／随意文本交给 harness。只参考本机 mcpfabric 的 VisionHandlers／MCP imageResult 字段独立实现，未复制实现或启动参考实例。

先核对 framebuffer 来源、worldSession／playerUuid／dimension、开始／结束 tick 和 PNG 头。原图最多 4096×2304、6 MiB，编码头／元数据／字节数一致才调用 Electron 解码；原生解码后再次核对尺寸。采样前后核查玩家和范围，换世界、tick 倒退或显著移动即停。等比例缩为最多 800×600、256 KiB 的 JPEG，清除源 PNG。每轮最多六次捕获，与既有工具共用互斥和 12 秒期限。

只有游戏客户端解析 `game-frame:`，普通工作客户端仍只接 `work-frame:` PNG。最近两张 JPEG 只在当前轮次内存保存；游戏日志仅随机引用和闭合元数据，新帧挤出旧帧，结束清空，重启不恢复。完整工具批次之后才附 image_url；每图按 16,384 单位同时计游戏／共享预留，既有 80k 单轮／100k 自主日／500k 总日上限不变。游戏 model/seen 记忆下标仍为空，目录不进私人存档，结束只通知计数与释放状态。

类型、lint、60 文件／377 项 Vitest 通过：PNG／JPEG 头、九类元数据或像素炸弹拒绝、图像协议隐私及 allowlist、工作客户端拒绝游戏图、逐轮同意／六帧上限／停止后迟到图像／跨世界及移动拒绝。既有 `smoke-minecraft` 和 `smoke-computer` 再次通过，普通书桌 PNG 和逐次审批仍有效。

`pnpm test:minecraft:images` 在真正 booth 隔离 profile、Electron、SQLite 和兼容 HTTP 上通过：原生 MCP 配置确认→截图默认未勾选→每轮显式同意→两次截图→模型 HTTP 依次含 0／1／2 张真实 JPEG→原生解码核对 16×12 合成天空／地面图→共享图像预留相等→停止核验→普通聊天无游戏文本／图像／引用→实际私人 ZIP 排除→重启不续玩。报告 `test-results/minecraft-images-report.json`。像素来自自有合成 fixture，不是真实 MC；模型是确定性本机服务器，不代表视觉理解质量。

用户确认实机复用 AIRI 测试配置。本轮只读提取 `C:/Users/86130/AppData/Roaming/@proj-airi/stage-tamagotchi/game-host.json` 的端点元数据：客户端 25600、服务端 25602；未输出 token，相关游戏／桥端口当时未监听。未改动、启动或接管参考实例。继续 survival 挖掘和展位预算；旧 6571c05 安装包不含此批，安装测试清单已加图像场景，暂未重打。

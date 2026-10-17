# #28：stdio 大截图的有限传输预算

2026-10-17 08:55。已核对本机锁定 SDK 1.32.1 的 client/stdio 与 shared/stdio：ReadBuffer 上限在完整 JSON 行解析前生效。修复前真正 Electron＋自有 Node stdio 已复现：合法 512×512 PNG 为 1,049,476 字节，JSON 为 1,400,394，连接关闭、模型没收到图、释放未核实。基线应用 7ea3832，报告 test-results/minecraft-stdio-legacy-report.json，不是只有静态计算。

仅对 allowTools 明确含 screenshot、privacy=none 的 stdio 连接，缓冲改为 9 MiB：6 MiB PNG→8 MiB base64，加有界 JSON／元数据余量。普通和隐私 stdio 仍 256,000。普通文本／结果、图像自身字节／尺寸／世界／玩家／取消守卫保留，未全局取消限制。

类型、lint、63 文件／408 单测通过。真实 Node stdio 单测证明普通连接和 privacy=always（即使列了 screenshot）仍拒绝 512k 文本并关闭；public screenshot 的较大传输窗口也不放行超出普通结果上限的文本，拒绝后连接保留。

`pnpm test:minecraft:stdio` 五项原生场景完整通过：

- 合法 1,049,476 字节 PNG，整条一次 write／342 次分片 write 均到达实际解码、512×512 JPEG、模型 HTTP、普通上下文／私人 ZIP 排除与后续停止核验。
- 合法 6,147,143 字节 PNG（1280×1200），8,197,286 字节 JSON 通过 stdio，实际缩为 640×600 JPEG，模型收到两图，停止核验通过。
- 6,556,948 字节 PNG 超图像预算：不送模型图像，连接仍 ready，核实释放。
- 9,439,298 字节 JSON 超传输预算：有界关闭，stopVerified=false，不冒充原生输入已松开。

报告 test-results/minecraft-stdio-{whole,fragmented,near-limit,image-oversize,transport-oversize}-report.json。MCP 世界、PNG 噪声、模型全部自有合成，未连真实游戏或供应商。安装矩阵已加场景，旧包未更新；真实 AIRI 配置的双客户端仍待上线。

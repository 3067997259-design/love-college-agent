# 真实服务的配置状态复核

2026-10-17 11:55。`pnpm probe:live-readiness` 仅启动新的隔离普通 profile，不完成新手流程、不发送消息；本机 providers 仍只由应用主进程读取。脚本只拿闭集快照的已装配槽位／可用端口标记，关闭后核对日志没有模型、语音或礼物请求。可用 `LCA_PROVIDERS_FILE` 指定本机文件，脚本不读取或打印其中的值。

本轮实际结果：chat／background／privacy 能装配，语音未装配、礼物端口已配置；没有发出模型请求。privacy 标记与早期空槽不同，但不能据此说学校隐私端点可连接或质量已过。另只读检查 25600／25602，Minecraft 桥仍未监听；未启动、改动或接管 AIRI、游戏或参考服务。IMAP 按用户要求继续记阻塞，不重测。Rodin 真实预算仍用 1/3，此探针不生成。

这只是选定配置的装配状态，不是连接、真实隐私质量、音色、OCR 或双客户端游戏验收；`connectionOrQualityAccepted=false` 明确保留。真实质量缺口继续列在第三圈完整性复核。

`pnpm probe:network` 只由主进程读已配置 privacy 的 origin，对 Node 和 Chromium 各做一次无凭据 HEAD，不读响应正文或调用模型，也不改网络设置。实际结果两者均未连通（Node 为 ECONNRESET），当前系统解析没有选中代理，不能认定换 Chromium 就能修好。两套网络栈及系统代理支持的区别见 [Electron 官方 net 文档](https://www.electronjs.org/docs/latest/api/net)。该诊断的地址、代理地址和配置值不返回脚本。

12:24 增补：新增 pnpm probe:privacy，经普通隔离 profile 原生导入一份合成短文本并打开 /privacy。真实任务按现有客户端上限四次尝试，持久事件均为 privacy/network，最终 privacy-unavailable；未调用 chat/background、没有成品。首次探针的计数断言误按三次写，已更正为当前四次上限；随后仅 --inspect 只读重开同一合成 profile，确认新增请求为零、原文不在快照／日志、普通 model/seen 为空，并生成闭集失败报告。没有重试真实服务，也没有读 IMAP 或生成 Rodin。该命令会真实请求供应商；非只读配置检查，不宜反复运行。学校端点的身份／连接／质量仍未确认。

12:42 审计 #37：探针现在先持久切到 quiet 并核对回执／快照，再导入资料；inspect 在启动应用前要求日志的最后模式为 quiet，旧 rest profile 保守拒绝，防止启动阶段消费完成事件。pnpm test:privacy-probe 配置合成 privacy/chat/background，成功／失败各一份文件及重开检查通过，chat/background 零请求、普通 model/seen 为空；原真实失败报告独立保留，没有新增真实请求。该回归追加到安装矩阵，下一包为 26 项。

用户后续明确确认：目前还没有选定 TTS／OCR 服务，会自行寻找。真实配置、模型与音色保留待办；现有合成验收继续保留，不替用户填默认供应商，也不把未装配写成实现失败。

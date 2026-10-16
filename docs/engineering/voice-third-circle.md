# 第三圈输出语音

接口 `c54c2ba` 先合 main：snapshot.voice、voice.set/stop/playback 和书本专用 readVoice。音频为临时 24 kHz 单声道 PCM16 小端分块；重启不重播，不带来源文本、供应商配置或凭据，不接麦克风和克隆音色。默认关闭，真实配置缺失时 unavailable，开发模式只用明确标记的合成测试音。

适配依据：[OpenAI 官方 TTS 文档](https://developers.openai.com/api/docs/guides/text-to-speech)，2026-10-17 核对。只在配置显式选择兼容协议时启用 `/audio/speech` + response_format=pcm；不擅自选定供应商、模型或音色。这里的协议支持不等于现有中转站一定支持；当前仍等待用户给出真实服务／音色／本机配置路径。

## 已接行为

只取已公开的完整成功回复，不读原始工具结果、邮件、附件、整理交付或心流原文，不对失败回合的半句做 TTS。启用时不补播此前消息；普通文字仍是原聊天投影，语音失败不删改它。新插话、显式停止、静音、安静、专注、熄灯、心流、游戏或书本隐藏时取消；250 ms 统一时钟守卫补齐自动阶段切换。忽略 AbortSignal 的返回也不能追加分块。请求不重试、不换供应商，30 秒、单条 1200 UTF-16 单元、30 次／日和 12000 单元／日上限，失败／取消计尝试。超长回复保留文字，不偷偷截断后冒充完整朗读。

设置和尝试只记作用域日志里的布尔值／字数／来源／日期；音频和朗读文本不额外写盘，不进普通经历、私人存档或诊断。重启可保留 enabled 偏好，但临时 utterance 为空，无自动补合成／重播。私人恢复也只恢复偏好和计费元数据。每次读取最多 8 块、每块 16 KiB，总量最多 30 秒；未知 id、错误游标、迷你窗／诊断窗／子帧拒绝。Renderer 的 playback 是播放遥测，不是工具执行证据。

## 本机配置

主进程在现有本机 providers 文件中读取可选 `providers.tts`，必须显式给出 `protocol: "openai-speech"`、`base_url`（HTTPS API 前缀）、`api_key`、`model`、`voice`，不提供默认模型／音色。不需新增 npm 依赖。配置仍通过既有主进程文件路径／原生导入，值永不返回界面或调试工具。请求禁止重定向，错误响应正文不打印，PCM reader 能处理奇数字节分片并拒绝 JSON／空／奇数／超量音频及跨分片凭据回声。实际 API 兼容性仍待用户提供的目标测量。

## Claude 接线

朴素设置有静音开关及“AI 合成语音”披露。书本已挂唯一 `VoiceAudio`／PCM 播放器，无定时器轮询，随分块计数增量读取，实际 AudioContext 排程与 ended 回调报告播放状态。嘴型／角色声音审美归 Claude；可使用 voice.utterance.playback，但不要在 mini 再开第二个播放器，不根据 synthesizing 自行宣称正在发声。开发 source=fake 是短测试音，不是角色嗓音。

## 实际验收

10 项单测通过：配置缺失／默认静音、成功公开消息、凭据遮盖、失败文字保留、四种取消／迟到、预算／数据上限、协议配置、分片错误及真实 loopback HTTP reader 取消。`node scripts/smoke-voice.mjs` 通过真实 Electron preload、PCM 数据、AudioContext 排程／结束、安静取消、书本白名单、重启偏好和不重播；测试用 webContents 静音，未在用户机器发声。合成数据／fake 模型／测试音，不是中文声音质量或真实 TTS 成本／延迟验收。

全量类型／lint、52 文件／296 项单测通过；基础 Electron、展位 profile 隔离和私人存档场景回归通过。本批未打新的安装包；安装态验收仍待全圈收口。

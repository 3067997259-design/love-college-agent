# 第三圈输出语音

接口先行：snapshot.voice、voice.set/stop/playback 和书本专用 readVoice。音频为临时 24 kHz 单声道 PCM16 小端分块；重启不重播，不带来源文本、供应商配置或凭据，不接麦克风和克隆音色。默认关闭，真实配置缺失时 unavailable，开发模式只用明确标记的合成测试音。接口这一步不代表后端、播放或真实服务已经验收。

适配依据：[OpenAI 官方 TTS 文档](https://developers.openai.com/api/docs/guides/text-to-speech)，2026-10-17 核对。只在配置显式选择兼容协议时启用 `/audio/speech` + response_format=pcm；不擅自选定供应商、模型或音色。这里的协议支持不等于现有中转站一定支持；当前仍等待用户给出真实服务／音色／本机配置路径。

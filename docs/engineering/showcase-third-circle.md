# 同一本书的连续验收

2026-10-17。`pnpm test:showcase` 是同一隔离 profile 的连续流程，不再逐功能重置状态。源码 Electron 及 6571c05 的实际安装版场景均已通过（安装版为 `pnpm test:package` 第 14 项，07:28 完成）。模型／邮箱／滤芯／生产器全部 fake，时间加速；真实文件、SQLite、窗口、PNG 和私人存档实际运行，不代表五分钟路演观感、真实服务质量或长时间运行。

同档顺序：

1. 扫合成邮件→用户专用原文／高亮核对→确认两张候选→生成实际日历文件，在独立无 bridge 预览里核对 VCALENDAR。
2. 邮件附件与合成文件先 staged，打开 `/privacy` 后由 fake 滤芯处理；成品只在用户预览，原文和成品不进普通上下文。
3. 一分钟合成番茄开始，书本隐藏、小窗显示；三步阅读实际回读哈希匹配才完成。休息保留小窗，实际点它回书本；随后三步写作同样有真实文件。
4. 两次普通共同经历进入成功模型输入；心流实际写书桌文件，退出后正文不回普通上下文；场景照片和全部私人数据导出。
5. 四点后安全翻页入睡；从旧页可见经历引用回忆并唤醒，检查普通上下文／记忆无原文；重启只有书本，恢复原存档后候选、两份作品哈希、心流文件及原照片全部保持。

报告 `test-results/showcase-report.json`，截图 `test-results/showcase.png`。报告明确 `oneProfile=true`、`syntheticServices=true`、`acceleratedClock=true`、`longTermRuntimeAccepted=false`。不把日历导出说成已经写外部平台；不把假隐私模型说成学校隐私服务已接通。

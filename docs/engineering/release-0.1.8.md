# v0.1.8：模型配置与运行链路收尾

2026-10-18。用户实测 v0.1.7 后报告连接测试成功但聊天未连接，以及记忆/日记和隐私滤芯缺少“跟随主模型”；要求再打包前详细审计。问题、修复与边界见 [运行链路审计](runtime-closeout-audit-20261018.md)。

## 修复范围

- 模型保存与路由立即应用到执行器；新配置后无需重启即可聊天。语音、Rodin、邮箱仍按界面提示重启。
- 记忆/日记可跟随主模型或独立配置；隐私跟随明确关闭隔离，主模型处理并看到新原文。独立隐私失败关闭，旧隔离来源不因切换自动公开。
- 礼物自动生成须先接受；日记中断后可补写；配置/礼物忙碌时不开始存档冻结。
- 修复隐私插件原始结果进入普通工具日志、首次配置覆盖其他服务、邮箱端口意外重置、Rodin 无效模型必填。
- 操作卡同步新流程。新增模型路由回归，打包场景从 33 增到 37，包含完整日记与礼物。

## 封包前证据

- 类型、lint 通过；Vitest 76 文件、551 项通过。
- 11 条源码 Electron 流程通过：providers、model-routing、model-slots、gifts、room、mcp、campus、documents、backup、onboarding、failure-narrator。Provider 最后复核包含 GUI 保存→连接测试→不重启发送。
- SQLite 原生模块在 Electron 44.7.2 / ABI 149 加载、关闭重开持久化通过。
- 使用合成服务和独立临时档，没有新读取真实邮件、调用真实供应商或发起付费礼物。

## 构建与交付

- 13:44 从干净源码 `4419b20e16bd3a569f7c23ddd6684860224dc680` 构建，`trackedDirty=false`。
- 安装器 `Love-College-Agent-0.1.8-Setup.exe`：264,368,180 字节，SHA-256 `1684118dbc60b620ef4dfd3f0cf06a814fb414ad1f05f7eee75eebab27922629`，签名状态 `NotSigned`。
- `app.asar` SHA-256：`1a796e371a6db30bd59321c683260bde7545d2861542076718408a83b8722ede`；包内 package 版本为 0.1.8，主进程与构建输出逐字节一致，检出“跟随主模型”“请她补写”“填写模型连接”“添加插件”。
- 安装器、blockmap、构建回执已复制到 `D:\lca-release-safe\v0.1.8\`，副本哈希一致。
- 13:54 `pnpm test:package --unpacked-only` 完成，**37/37 场景通过**；另有 SQLite/日志/番茄/存档/记忆/生活/心流七类原生探针、普通 UI 重启、历史页照片与引用恢复通过。
- 报告 `test-results/package-unpacked-report.json`：`ok=true`、`executionTarget=unpacked`、`installedProbes=false`、`syntheticServices=true`、`realProviderQualityAccepted=false`。本次一轮通过，不借用旧包报告。

本机已有同名用户安装，打包检查使用 `pnpm test:package --unpacked-only`，不升级或卸载用户安装。它不代替安装器升级和第二台 Windows 人工验收。真实日记文笔、付费礼物质量与耗时、TTS/OCR、长期自主运行仍有独立边界。

## 交付入口

- [GitHub Release v0.1.8](https://github.com/3067997259-design/love-college-agent/releases/tag/v0.1.8)：安装器、blockmap、构建回执、校验和、包内回归报告和 `LCA-Demo-Kit-v0.1.8.zip`。
- 固定副本 `D:\lca-release-safe\v0.1.8\`，源构建目录 `D:\lca-gpt\release\`。操作卡包含首次配置、评委讲稿、展位方案、公开样例、三种独立启动入口及此次审计全文，不含私人存档或配置。
- 代码修复已快进 main；本轮不改变仓库可见性，也不提交赛事表单。公开 J0/J1/V0、第二台全片试播和真人计时彩排仍由现场实际完成。

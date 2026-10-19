# Love, College & Agent

一个住在书里的桌面 Agent：帮你处理资料和校园事务，也与你积累共同经历。

左页是她的房间，右页是你们的对话、计划和工作成果。专注时，她在桌面的小窗里安静陪伴；休息时，你们再交流。工作、记忆和她自己的日常属于同一个角色。

![内置角色桃子的房间画面](src/renderer/src/assets/character/taozi/close/facing-user_calm.webp)

*图为应用内置美术素材。角色称呼、静态角色包与个人存档分别管理。*

这是由 **AfterRain** 个人长期维护的开源项目，当前处于早期迭代阶段。面向 Windows x64，使用用户自行配置的模型服务；项目自身不设付费墙或订阅，外部服务可能产生费用。

[下载安装](https://github.com/3067997259-design/love-college-agent/releases/latest) · [开始使用](docs/getting-started.md) · [文档](docs/README.md) · [参与贡献](CONTRIBUTING.md) · [反馈问题](https://github.com/3067997259-design/love-college-agent/issues)

## 现在可以做什么

| 能力 | 当前范围 |
| --- | --- |
| 对话与工作 | 流式对话、工具执行记录和多步心流；当前文件与命令只支持受管理书桌中的小型纯文本项目。 |
| 资料整理 | 导入 UTF-8 文本、Markdown、文字层 PDF，生成可打开的本地整理文件。 |
| 校园事务 | 从证据形成候选，查看原文、确认或忽略，再导出本地 `.ics` / Markdown；校园助手需另外安装、配置 Student Hub。 |
| 专注陪伴 | 确认番茄计划、计时、桌面迷你窗；专注与暂停全部后台活动分别控制。 |
| 记忆与旧页 | 按日保留对话、检索带来源的记忆、纠正事实、翻阅旧页与引用；不保证每次回忆都准确。 |
| 角色生活 | 持续保存作息、外出、带回物和日记；虚构生活事件与真实执行的工作分开记录。 |
| 礼物与存档 | 羽毛笔、私人 `.lca-save` 导出和恢复；其他 3D 礼物需要可选生成服务与用户同意。 |
| 扩展 | 本地代码插件、Markdown skills、MCP 连接及静态角色包。 |

## 开始使用

1. 从 [Releases](https://github.com/3067997259-design/love-college-agent/releases/latest) 下载 Windows x64 安装器。当前安装器未签名，请核对发布来源。
2. 打开应用，按向导填写昵称和“日常对话”的接口地址、模型名、API 密钥，保存并测试连接。
3. 先完成一次对话，再拖入一份公开的文本或文字层 PDF，让她帮你整理。
4. 校园助手、语音和实时礼物按需配置，不是开始使用的前提。

**新安装默认让记忆、日记和隐私处理跟随主模型。** 隐私“跟随主模型”表示主模型可以处理获授权的邮件和文件原文；独立隐私模型失败时业务停止，不自动回退。配置前请读 [隐私与数据](docs/privacy-and-data.md)。

完整步骤、依赖和故障处理见 [使用指南](docs/getting-started.md)。

## 从源码开发

使用 Node.js 24.14.0 或更新的兼容版本、pnpm 11；Windows 原生构建还需要 C++ 构建工具。每个 checkout 单独安装依赖。

```powershell
git clone https://github.com/3067997259-design/love-college-agent.git
Set-Location love-college-agent
pnpm install --frozen-lockfile
pnpm setup:electron
pnpm rebuild:native
pnpm dev
```

原生依赖、缓存、数据目录、构建与测试见 [开发与打包](docs/deployment.md) 和 [测试说明](docs/testing.md)。

## 当前边界与后续方向

当前发布基线为 **v0.2.0**（demo 验收版，D1–D4）；功能范围与验证条件见 [版本记录](docs/releases/0.2.0.md)。合成模型的流程测试、真实服务连通、第二台机器安装和长期日用分别验证。

- 校园插件依赖独立的 Student Hub 后端和学校登录配置，没有通用的多学校即插即用能力。
- 可靠资料输入是文本和文字层 PDF；真实 TTS / OCR 质量、长期自主生活体验仍需继续验证。
- 当前不能直接把用户已有工程作为心流工作区，仍受书桌和文本副本限制；正在研究 [真实项目工作区与执行后端](docs/research/harness-workspaces-20261019.md)。
- 本地导出不代表已写入手机日历或外部待办平台。
- 私人存档当前不加密，含聊天和可能的私有证据，请自行保管。

接下来优先改善安装配置、真实日用、连续性与数据可靠性，再逐步扩展角色与工作能力。具体方向见 [维护计划](docs/maintenance.md)；尚未实现的方向不作为现有功能承诺。

## 起源、致谢与许可

项目起源于 Techathon 2026。比赛终版保存在 [Hackathon 分支](https://github.com/3067997259-design/love-college-agent/tree/Hackathon) 与 [冻结标签](https://github.com/3067997259-design/love-college-agent/tree/hackathon-2026-final)，main 持续维护。历史材料入口见 [项目历史](docs/history.md)。

感谢相关开源项目、工具与创作者。设计参考和素材来源见 [参考与来源](docs/reference-research.md)、[第三方说明](THIRD_PARTY_NOTICES.md)。

本项目以 [MIT 许可证](LICENSE) 开源，Copyright (c) 2026 AfterRain。第三方依赖、字体和引用素材遵循各自许可证。

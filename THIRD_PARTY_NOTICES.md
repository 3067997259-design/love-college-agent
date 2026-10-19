# 第三方依赖与资源说明

Love, College & Agent 的许可证见 [LICENSE](LICENSE)。第三方包、字体和引用素材遵循各自许可证；完整版本与传递依赖由 `package.json`、`pnpm-lock.yaml` 及分发包附带声明确定。

## 主要依赖

| 包 | 许可声明 | 用途 |
| --- | --- | --- |
| Electron、React、React DOM | MIT | 桌面运行时与界面 |
| Zustand、Zod | MIT | 状态与结构校验 |
| better-sqlite3、imapflow、mailparser | MIT | 本地存储与邮箱 |
| JSZip | MIT（双许可中选 MIT） | 私人存档容器 |
| @modelcontextprotocol/sdk | MIT | MCP 客户端 |
| pdf-parse | Apache-2.0 | 文字层 PDF |
| @google/model-viewer | Apache-2.0 | 本地 GLB 预览 |
| TypeScript、Playwright | Apache-2.0 | 开发与自动化 |
| Vite、electron-vite、Vitest、electron-builder | MIT | 构建、测试与安装器 |

Electron 发行包含 Chromium 等组件，保留随发行提供的第三方声明。表格不是完整许可证文本，也不替代各包和传递依赖的附带文件。

## 字体

- Long Cang：通过 `@fontsource/long-cang` 提供，SIL OFL-1.1。
- 霞鹜文楷：`lxgw-wenkai-screen-web` 的包声明为 MIT，所含字体采用上游 SIL OFL-1.1。

字体随应用打包，不从网络临时加载。新增字体需保留其实际字体许可与署名，不能仅以 npm 包字段代替字体来源。

## 参考、生成素材与外部服务

机制参考包括 deepseek-harness、AIRI / 维护者 fork 与 Neko DevLog，范围见 [参考与来源](docs/reference-research.md)。Student Hub 是独立校园后端，mcpfabric 是外部游戏联动研究；应用不内置它们的个人数据或认证。

桃子人设改编自维护者原创 ReLU 角色卡，私人原卡不公开。画面使用 NovelAI / GPT-image 等工具制作与局部精修，人工复核采用，记录见 `art/` 与 [美术规格](docs/art-spec.md)。历史动画另使用 MiniMax H3 / CompShare，实时礼物可选 Rodin；服务名称不表示其所有输出质量均已验收。

Nestopi《放松时光》、角色 PV 等仅作体验或抽象视觉参考，不作为本项目角色、音乐或镜头资产来源。

## 历史影片配乐

本地历史 V8 短片使用 Orangestar《花筏》（feat. 夏背）原曲，相关著作和录音权利不属于项目维护者；现有制作记录没有独立网络发布授权凭证。原曲及影片原件保留在本地归档，不随本轮文档整理新增公开分发，也不包含在代码 MIT 声明内。

原始资源清单与当时核对版本见 [冻结技术与资源说明](https://github.com/3067997259-design/love-college-agent/blob/hackathon-2026-final/docs/submission/02-%E6%8A%80%E6%9C%AF%E8%AF%B4%E6%98%8E.md)。

# 插件与校园助手

插件书签集中管理本地插件、skills 和外部 MCP。日常动作与候选在日程页处理，设置中的快捷入口只负责打开插件页。

## 校园助手

当前推荐入口是 [campus-assistant](../plugin-packages/campus-assistant/README.md)，需要 LCA v0.1.10 及另行安装、配置和登录的 Student Hub 后端。插件不附带后端工程、Python、个人数据库、学校账号或登录状态。

1. 从 [Release](https://github.com/3067997259-design/love-college-agent/releases/tag/v0.1.10) 获取校园助手包，或使用仓库中的 `plugin-packages/campus-assistant`。
2. 在普通模式的插件页添加该目录，核对实际路径与指纹后启用。其他电脑参考包内 `connection.example.json` 填写后端、Python 和配置路径；连接文件不放账号密码。
3. 请她“检查校园助手是否准备好了”。检查只证明依赖与配置存在，不证明账号认证。
4. 需要真实采集时，明确要求扫描；等待同一个 jobId，查询进度或取消。扫描结束后读取并整理证据，再在书页核对候选原文、确认或忽略。
5. 确认后点击“导出新确认事项”，从交付卡打开实际 `.ics` / Markdown。

也可只“导入已有校园事项”，读取已有结果而不发起新扫描。重复导入保留当前决定，有实质日期变化才形成新版本。来源失败不能解释为没有更新，本地文件不等于外部日历 / Todoist 写入，插件不支持课程提交。

启用一体插件后，旧 `student-hub` MCP 与 `student-hub-candidates` 工具不再重复提供，已有候选和忽略记录保留。旧包保留用于兼容与调试，不再作为新用户的组合安装步骤。

## MCP 与本地代码插件

MCP 支持 stdio 和 Streamable HTTP。使用标准 `mcpServers` JSON 导入，连接时核对 fingerprint 及原生窗口里的实际命令 / 参数或地址；精确工具白名单由用户配置，重启不自动重连，OAuth 尚未接入。

本地代码插件按 manifest 声明工具、权限、入口和家具槽位，由用户核对指纹并启用。代码插件会在主进程的插件边界执行，不应把安装未知插件等同于只读文档导入。

私有工具结果走主进程窄出口，原文不直接作为普通工具回执。隐私模式见 [隐私与数据](privacy-and-data.md)；模型输出仍需校验，不把插件声明当作可信内容证明。

开发入口为 `src/main/plugins/`、`src/main/mcp/`、`src/shared/` 与 `plugin-packages/`。现有完整包可作为接口示例，外部依赖、工具权限和数据归属需要逐项说明。

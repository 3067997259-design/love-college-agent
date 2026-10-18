# Student Hub MCP plugin package

这是一个 LCA 的 **MCP 插件包**，不是 Student Hub 专用适配器。它只是标准的
`mcpServers` 配置，安装后走现有的 MCP 客户端、权限确认、隐私出口和工具白名单。

- 在书房「插件」→「添加插件」→「添加自定义 MCP 服务器」中选择本目录的
  `mcp.json`。
- 安装后列表出现 `student-hub`，说明为“校园邮箱、日程与资料”；开关默认关闭，
  首次连接仍需指纹确认。
- 白名单只开放只读状态、发现和扫描轮询；`resolve_review_case`、
  `export_todoist_jobs`、课程状态修改、资料下载和提交工具都不在这里。
- `privacy: "always"`：没有可用隐私模型时，调用会关闭，不会把校园原文交给主模型。
- `config` 和 `PYTHONPATH` 指向本机 `D:\student-hub`；移动 Student Hub 后需要改这两个
  路径。配置里没有密码、令牌或邮箱内容；密码由 Student Hub 自己的 keyring 提供。
- 这个包不复制或修改 Student Hub 的配置、数据库和凭据；它只是启动其现有 MCP
  服务。真实扫描仍是只读来源操作，但会在 Student Hub 自己的本地证据库里记录结果；
  需要用户自己触发和确认。

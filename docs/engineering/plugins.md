# 最小插件加载器（2026-10-16）

2026-10-18 补充：书页新增「插件」书签第一版，左侧自定义导航分为插件／技能／已安装；本地插件目录通过 `plugin.install` 校验后复制到数据根，MCP 配置通过 `mcp.configure.path` 由主进程读取路径导入。已安装列表不显示未安装占位；mcpfabric 是外部插件，安装后才出现。仍不设远程插件市场。MCP 开关先弹出“MCP 连接确认”并展示 fingerprint，确认后才调用 `mcp.connect`；设置里的连接分区和输入框旁都能打开插件中心，不再复制第二套本地插件或 MCP 列表。开发者平铺面板的 `McpControls` 也已删除，正常／展位／开发者都从插件中心连接。

Student Hub 这类的 **MCP 插件包**不写专用适配层：包内就是标准 `mcpServers` JSON（示例 `plugin-packages/student-hub/mcp.json`），用同一个“添加自定义 MCP 服务器”入口导入；导入按 server id 合并到现有配置，不覆盖已有插件，行名和说明由 MCP 列表统一显示。工具白名单、隐私标记和连接确认仍走 MCP 客户端。

内置 `core`（时钟、任务计划）已经过注册表装入，harness 每一步只公布当前启用的工具。外部插件放在数据目录的 `plugins/<目录>/manifest.json`，重启发现；不设市场、不开放循环钩子，也不执行 renderer 代码。清单校验失败的目录忽略，API 版本或工具名冲突显示 incompatible。

第零圈后续已加入 `pomodoro`（5 个计时工具）与仅开发模式存在的 `developer`（调试服务）。Claude 的活动模板可对齐 `clock.read`、`plan.update`、`pomodoro.plan_pomodoros`、`pomodoro.start_focus`、`pomodoro.pause`、`pomodoro.stop`、`pomodoro.get_timer`；未提供专用文字时沿用现有通用回退，本线不内联人物台词。

清单版本一：`apiVersion: 1`、`id`、`name`、语义版本 `version`、`description`、`privacy: none|optional|always`、`permissions`、`tools`；代码入口 `entry` 仅接受目录内 `.cjs`。每个工具声明 `name`、`description`、对象 JSON Schema `parameters` 和活动 `templateId`。可选 `furniture` 只声明槽位及目录内图片；界面素材呈现留到后续接入，当前加载器只校验路径。可选 `configSchema` 保留声明，尚无自动配置表单。禁止引用型 JSON Schema，避免远端解析；参数由 Zod 的 JSON Schema 导入器校验。

带代码的插件首次启用须在“工具与设置”核对权限并确认 manifest＋入口代码的 SHA-256。修改入口后旧确认失效。批准的本地 Node 代码拥有当前用户权限；这是明确授权的可信插件机制，不宣称隔离沙箱。首版代码插件使用单文件入口，修改后重启重新发现。素材声明本身不带可执行代码。清单和工具结果均有大小限制；路径经过 realpath 校验，拒绝越界与目录符号链接。

入口示意（技术示例，不含角色台词）：

```js
module.exports = {
  activate({ ingestCandidates, nowMs }) {
    // Optional: a source plugin may contribute bounded candidate seeds on enable.
    void ingestCandidates
  },
  tools: {
    example: async (args, { nowMs, signal, turnId }) => ({
      ok: true, raw: { timestamp: nowMs() }, visible: { timestamp: nowMs() }
    })
  }
}
```

外部工具拿不到 store 或供应商对象。结果 `raw` 仅入受保护日志，`visible` 才能进入她的上下文，`fields` 仅允许短字段。需要过滤时，没有隐私模型就不调用工具；过滤失败不向主模型回退。隐私过滤后的出口限于已校验枚举、日期和短任务字段。插件中心可以覆写各插件标记。

**候选出口（2026-10-18）：** 代码插件可选导出 `activate(context)`；启用时调用一次，`context.ingestCandidates(seeds)` 把有界候选交给主进程。工具结果也可以带 `candidates`，registry 转交宿主后立即剥离，不进入模型投影或普通工具日志。候选只含外部 id、标题、截止／活动时间、来源和用户可见证据摘录；主进程重新校验长度和时间，写入现有候选／证据库，确认／忽略和导出沿用原流程。`privacy` 为 `always`（或 `optional` 且开启文件过滤）的外部插件不能通过这条路径绕过滤芯；只有 `privacy: none` 或内置的 `handlesPrivacy` 插件可用。示例见 `plugin-packages/student-hub-candidates`。

已验证：指纹确认前不执行、入口变动拒绝、API/路径拒绝、参数校验、停用及持久配置、隐私未配置时 fail closed。真实 Electron 也已用合成文件夹插件跑过 UI 授权与模型工具调用，检查 raw 不进上下文、重复启用不重跑初始化。真实第三方插件和家具画面尚非本轮验收范围。

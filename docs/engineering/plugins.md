# 最小插件加载器（2026-10-16）

内置 `core`（时钟、任务计划）已经过注册表装入，harness 每一步只公布当前启用的工具。外部插件放在数据目录的 `plugins/<目录>/manifest.json`，重启发现；不设市场、不开放循环钩子，也不执行 renderer 代码。清单校验失败的目录忽略，API 版本或工具名冲突显示 incompatible。

清单版本一：`apiVersion: 1`、`id`、`name`、语义版本 `version`、`description`、`privacy: none|optional|always`、`permissions`、`tools`；代码入口 `entry` 仅接受目录内 `.cjs`。每个工具声明 `name`、`description`、对象 JSON Schema `parameters` 和活动 `templateId`。可选 `furniture` 只声明槽位及目录内图片；界面素材呈现留到后续接入，当前加载器只校验路径。可选 `configSchema` 保留声明，尚无自动配置表单。禁止引用型 JSON Schema，避免远端解析；参数由 Zod 的 JSON Schema 导入器校验。

带代码的插件首次启用须在“工具与设置”核对权限并确认 manifest＋入口代码的 SHA-256。修改入口后旧确认失效。批准的本地 Node 代码拥有当前用户权限；这是明确授权的可信插件机制，不宣称隔离沙箱。首版代码插件使用单文件入口，修改后重启重新发现。素材声明本身不带可执行代码。清单和工具结果均有大小限制；路径经过 realpath 校验，拒绝越界与目录符号链接。

入口示意（技术示例，不含角色台词）：

```js
module.exports = { tools: {
  example: async (args, { nowMs, signal, turnId }) => ({
    ok: true, raw: { timestamp: nowMs() }, visible: { timestamp: nowMs() }
  })
} }
```

外部工具拿不到 store 或供应商对象。结果 `raw` 仅入受保护日志，`visible` 才能进入她的上下文，`fields` 仅允许短字段。需要过滤时，没有隐私模型就不调用工具；过滤失败不向主模型回退。隐私过滤后的出口限于已校验枚举、日期和短任务字段。设置页可以覆写各插件标记。

已验证：指纹确认前不执行、入口变动拒绝、API/路径拒绝、参数校验、停用及持久配置、隐私未配置时 fail closed。真实第三方插件和家具画面尚非本轮验收范围。

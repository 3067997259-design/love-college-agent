# Student Hub 候选卡

这是一个本地代码插件，不是 MCP 服务器。它把本机 Student Hub 中已经整理出的校园事项，映射成桃子书页上的 LCA 候选卡，并使用 LCA 现有的候选、证据和确认流程。

## 边界

- 只读打开 `D:\student-hub\var\student_hub.sqlite3`（可由 `LCA_STUDENT_HUB_DB` 指定），以 SQLite `mode=ro` 和 `PRAGMA query_only=ON` 双重保护。
- 入口 `index.cjs` 在每次执行前校验 `read-items.py` 的 SHA-256；辅助脚本被改动后插件停止，不会沿用旧指纹静默执行。
- 不扫描邮箱、不调用 Student Hub 的 MCP 服务器、不读取密码、不写 Student Hub、不写外部日历或 Todoist。
- 只导入 `needs_review`、`confirmed`、`synced` 且带截止时间或开始时间的事项；已忽略、已取代、已完成和没有日期的公告不会变成卡片。
- 候选卡中的“原文”是 Student Hub 已保存的主题、摘要和原文预览，不是重新抓取的邮件正文。插件的候选片段只进入用户自己的 LCA 证据库，不进入模型上下文或普通工具日志。

## 配置

默认值：

- 根目录：`D:\student-hub`
- Python：`C:\Users\86130\anaconda3.0\python.exe`，不存在时使用 `python`（需要 Python 3.11+ 的 `tomllib`）
- 配置：`<root>\config\sources.toml`

可用环境变量覆盖：`LCA_STUDENT_HUB_ROOT`、`LCA_STUDENT_HUB_PYTHON`、`LCA_STUDENT_HUB_CONFIG`、`LCA_STUDENT_HUB_DB`。

## 装入

在 LCA 的“插件中心”选择本目录安装，核对指纹并启用。启用时会自动导入一次；之后可以让她调用 `import_student_hub_candidates` 刷新。导入是幂等的：同一事项内容不变时不会反复追加版本。

当前映射是**候选来源插件**，不把 Student Hub 的确认状态自动当成 LCA 的确认；导入后的卡片仍需在桃子的书页里确认或忽略。

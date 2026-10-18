# 巡场前收尾审计

2026-10-18 12:20 起。目的：核对现有交付和曾承诺的演示，不扩张业务。本轮读取当前 main 工作区、源码门禁、安装器回执、真实探针报告和视频交付记录；没有读取 secrets、私人邮件／数据库或启动参考项目。

## 可用包与新证据

当前界面包：`D:\lca-live-test\Love-College-Agent-0.1.0-Setup-new.exe`，264,350,354 B；本轮实际重算 SHA-256 `E393FA84AC252643DE83221F2C1064B5CD4BFA45DCDD44299D022222D3FDB1A2`。

`release/build-receipt.json`：`sourceRevision=c87def116d5afc0a117dd9a0efb3f196755a7d86`、`trackedDirty=true`、构建时间 `2026-10-18T04:03:39.290Z`。因此这个提交 SHA 单独不足以复现该包；当前主工作区还有未提交界面／插件／后端改动和未跟踪代码。收尾文档独立在 `D:\lca-gpt` 的 `codex/demo-closeout` 分支编写，保留这些已有工作。

已额外保全应用源码差分与 21 个未跟踪应用文件：`D:\lca-release-safe\closeout-source-20261018T0424Z.zip`，SHA-256 `25a0b2ed73ba15a93c6bf1185735aab84507ea16130104e1b770d415f0012f26`。包含基线提交、tracked.patch 与逐文件哈希；采集时内容稳定，不含 secrets／运行库／私人存档。它是保全快照，**未验证与安装器逐字节等价**，也不替代最终源码提交。

本轮直接指定安装后的 `D:\lca-live-test\app-next\LoveCollegeAgent.exe`，顺序运行六条现有 smoke（无 build、独立测试数据、窗口透明）：

| 场景 | 本轮结果 | 证据范围 |
| --- | --- | --- |
| `node scripts/smoke-booth.mjs` | PASS | 展位／个人数据隔离、开发入口拒绝、重启 |
| `node scripts/smoke-onboarding.mjs` | PASS | 真正向导表单、重启、原生存档导入与恢复 |
| `node scripts/smoke-documents.mjs` | PASS | 拖入／选择、PDF 子进程、实际 Markdown、原文隔离、失败关闭 |
| `node scripts/smoke-pomodoro.mjs` | PASS | 计划确认、计时持久化、真实双窗口、重启与回退 |
| `node scripts/smoke-providers.mjs` | PASS | 新模型 GUI 保存／测试／清除、其他连接卡、密钥不进入快照 |
| `node scripts/smoke-plugins.mjs` | PASS | 新插件中心、路径导入、指纹确认、设置与输入框快捷入口 |

均为**实际安装 EXE＋合成服务**，不等于新包完整 26/26，也不等于第二台电脑或本次真实网络通过。`test-results/package-report.json` 的 `ok=false/stage=preflight/completedScenarios=[]` 必须保留；旧 v0.1.6 的完整 26 场景通过不能移植给新包。

历史但本轮读到的真实报告：`privacy-live-report.json` 为 1 次真实 privacy、实际 Markdown 与基础事实匹配，`broadQualityAccepted=false`；Student Hub 只读扫描 3 artifacts／0 actionable review cases／无外部写入。最新 UI 真实聊天证据见 [测试安排](test-automation-20261018.md)。历史结果与本轮重跑分开。

## 安装包内容与 GitHub Release 核对

用户指出最新 UI／文案可能未进 Release 后，本轮使用 GitHub CLI 只读核对：最新发布仍为 v0.1.6，目标 `0aaebf6…`，资产 SHA `62c5aac8…`；它不是本机 12:03 的新包。

另直接读取新安装 EXE 的 app.asar：SHA `dd54afb52349cf28c573cefd940f4159b7123eeb46d6d3f14d595492fb943d24`，与构建回执相符。主进程 `out/main/index.cjs` 和 renderer `index-CUgmtsF5.js` 均与当前 `out/` 字节一致；安装内检出“给书房添上颜色”“填写模型连接”“模型与声音”“连接与插件”“保存邮箱连接”“添加插件”六项新 UI／文案标记。因此最新改动已进入本机安装包，**尚未进入 GitHub 最新 Release**。本轮不修改远端 Release 或发布状态。

## 说了但要改口／补交付的内容

| 优先级 | 发现 | 当前事实与收尾决定 |
| --- | --- | --- |
| P0 | 部署写“安装后从开始菜单启动” | NSIS 配置 `createDesktopShortcut=false/createStartMenuShortcut=false/runAfterFinish=false`。现有包须从安装目录运行 `LoveCollegeAgent.exe`；先补准确说明和独立启动脚本 |
| P0 | 旧路演允许 privacy 失败后“跟随主模型” | 与失败关闭代码冲突；删掉此路径。缺 privacy 就暂停该项或展示已完成样例，不向主模型发送原文 |
| P0 | 展位现场“扫描真实邮箱／安装候选插件” | `index.ts` 只在非开发且非展位创建真实 IMAP；`developer/runtime.ts` 拒绝展位 `plugin.install`。拆为独立普通评委档、独立展位访客档 |
| P0 | “把通知截图拖进来” | 文件处理可靠入口为文字层 PDF／UTF-8 文本／Markdown；真实 OCR 未验收。公开展示使用随附文本样例 |
| P0 | “清空本地数据再恢复” | 应用已有自动备份和确认恢复；现场不删文件夹，使用独立公开演示档，确认一次后等重启 |
| P0 | 用新包替换了旧包，却继续称“最终包 26/26” | 新包回执 dirty，完整安装测试止于保护已有安装的预检。本轮补测六条；仍需源码封存、第二机和选定终包 |
| P1 | “配 privacy 就不发给模型服务商／不出校” | privacy 是指定模型端点，是否校内部署不是槽位名字能证明；只承诺不发普通聊天槽位 |
| P1 | “她不会忘记你／永久记住所有事” | 保存用户原始记录与模型准确回忆是两件事。改为可追溯、可恢复；不承诺永久完美回忆 |
| P1 | “任何工具／控制整个电脑” | MCP 白名单与审批；computer use 只在隔离静态书桌预览，命令受范围限制且展位关闭 |
| P1 | “离线也会读书、写作” | 离线只补虚构世界事件；真实生产不补跑。生活读写输入仍限已登记材料，真实 background 质量未验收 |
| P1 | “换一所学校接 MCP 就能用／安装包内置 Student Hub” | 第二机仍需要外部项目、Python、认证和来源适配；已有候选桥只读本机事项，不等同扫描后自动全业务接通 |
| P1 | 全校展位以 MC 双客户端吸引体验 | 本次撤出演示流程、讲稿和提交功能列表。历史实验实现不宣称实机验收；是否彻底删代码尚未收到用户答复 |
| P1 | “已有演示存档就有公开可展的旧页／礼物” | 已有 `demo-mail-day2.lca-save` 含个人邮件证据，不能给访客。公开 J0/J1/V0 仍待实际准备；旧页带回物未证实存在 |
| P1 | “提交视频／PPT／公开仓库都齐了” | V8 完整现场短片已有文件；PPT 当前看到大纲、截图仍注明占位，提交表单无完成证据，公开链接访问本轮未验证。不能以文档存在代替成品与提交 |

## 已有实现，不能再笼统说没做

校园证据→候选→确认→本地交付、资料整理、文字记忆和纠正链、日会话／旧页、私人备份恢复、番茄和迷你窗、心流／工作区、确定性外出与生活状态、加密日记、静态角色包、礼物链都有实现和分层记录。真实邮箱和 privacy 的早期阻塞已被后续真实验证更新，不沿用 10-16 的旧阻塞结论。

真实 TTS／OCR、开放式长期自主生活质量、真实多学校即插即用、一图生成完整角色包、任意系统桌面操作均不升级成现场承诺。当前做的是工作与相处连续性的可操作原型。

## 本轮交付与尚未完成

- [安装卡](../exhibition/first-run.md)、[全校展示](../exhibition/booth-runbook.md)、[评委操作卡](../exhibition/judges.md)、[公开资料](../exhibition/public-notice.md)、`scripts/Start-LcaDemo.ps1`。
- 启动脚本通过语法检查、三种模式只读预检；未由本轮脚本实际打开三套有配置的现场书本。原生应用的模式隔离由上表实际安装版 smoke 验证。
- 第二台电脑：用户 12:20 前回报仍在复制／安装，第一句真实聊天和重启保留尚待回报。
- MC：已从演示策划撤下；现有包里的历史 MC 控件／实现仍在，本轮不把文档撤项说成二进制已删除。
- 公开演示档、目标机全片试播、三遍计时彩排、PPT 实体／提交材料定稿、终包源码封存与对外提交仍待实际完成。脚本不会自动生成这些证据。

此文件是可核对的收尾台账，不是“全部验收完成”的声明。

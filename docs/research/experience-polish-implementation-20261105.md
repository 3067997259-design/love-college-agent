# 体验与灵魂升级：实施记录与验证

- 日期：2026-11-05
- 分支：`codex/experience-polish`（基于 `codex/continuous-work-p0` 基线 `6a86e1b`）
- 范围：按[总纲](experience-polish-master-plan-20261105.md)顺序执行[01 人设与 Prompt](experience-polish-01-persona-and-prompt-20261105.md)、[02 世界泡与日记](experience-polish-02-world-and-diary-20261105.md)、[03 子代理分镜](experience-polish-03-subagent-strip-20261105.md)、[04 界面与设置](experience-polish-04-ui-and-settings-20261105.md)。本次**未提交**，留给维护者审阅。

## 1. 实际改动

### 人设与上下文（文档 01）

- [taozi.zh.json](../../src/main/characters/taozi.zh.json)：按原创卡 ReLU 的内核重写（沉默作为容器、矛盾共存、苦甜交织的无常觉知、冷幽默、锋利边界），恢复“浅层寒暄留白、深度对话全情投入”；明确不点名房间道具、不报备起止钟点、不清点物品、不重复已说过的日常。`brief` 同步压缩，仍满足 400 字上限。
- [index.ts](../../src/main/index.ts)：角色卡以自然散文进入系统层（删掉 `JSON.stringify({ characterCard… })` 包装），用户档案居中，执行准则后置并声明优先级；尾置提醒改为语气锚点（深度全情、不复读、不点道具）。
- 维护者审阅后又改了几处（裁定见[文档 01](experience-polish-01-persona-and-prompt-20261105.md) 2.1 节）：用户是谁改由“关于你”档案自己写，卡里一律称“对方”；写明成年；被问是不是 AI 照实说是；边界改为冷静拒绝或退开，不再“锋利”；尾置提醒去掉具体性格，导入的角色也能用。
- [policy.json](../../src/main/harness/policy.json)：删掉“你是这个桌面应用中的个人 Agent”的破功开场，保留全部事实、隐私、来源、时间与虚构边界。
- [state.js](../../dsh/lca-bridge/state.js)：门牌/工作交接协议文案收敛错别字并去掉重复法条；保留全部安全门（只依据当前意图、旧凭据失效、worker 不接协议、chat→work 不重复切换）。
- [life/reference.ts](../../src/main/life/reference.ts)：`worldFactsNote` 增加“仅作背景感知、不主动报备钟点与数量、已提过的不重复”。

### 世界泡与日记（文档 02）

- 外出地点从海岸/秋千扩到旧书店、咖啡馆、天台、便利店（[shared/state.ts](../../src/shared/state.ts)、[life/schema.ts](../../src/main/life/schema.ts)、[controller.ts](../../src/main/bridge/controller.ts)）；没有专用外景的地方左页回退到空房间加亲笔纸条；只有海边/秋千带回贝壳或叶子，`item` 可为 `null`。自动散步的时长按日期在 30–59 分钟浮动，离线补算仍是固定的整小时；离线/显式提议行为不变。
- 新增 [life/tools.ts](../../src/main/life/tools.ts)：`life_outing`（提议、出发、提前回来）与 `life_schedule`（今日作息），注册到 `life-work` 内置插件；她能在对话里真正改变自己的日程，不需要用户在面板上遥控。
- [DiaryBook.tsx](../../src/renderer/src/book/sheets/DiaryBook.tsx)：删掉“主观日记”印章、副标题改为“她留在夜里的私人字迹”，旧记录首行的“主观日记”自动隐藏；日记页不再显示 ZIP 密码与打开文件夹按钮（设置里的用户独占查阅保留）。
- [diary/prompts.json](../../src/main/diary/prompts.json)：改成睡前私人手记的口吻，支持 `shy`；[diary/service.ts](../../src/main/diary/service.ts) 在 `shy: true` 时把解锁时间放到 18 小时后，手动“请她补写”立即解锁。
- [ScheduleSheet.tsx](../../src/renderer/src/book/sheets/ScheduleSheet.tsx)：删掉“几点看书没做成”的打卡表与四个遥控外出按钮，只留一句自然近况（在书房／在哪儿、几点回／今天去过哪）和“叫她回书房”。

### 子代理分镜（文档 03）

- 新增 [SubagentStrip.tsx](../../src/renderer/src/book/team/SubagentStrip.tsx) 与 [subagent-strip.css](../../src/renderer/src/book/team/subagent-strip.css)：左页底部最多三格手账特写，局部取景来自 `room-day.webp`（书架、桌面、阳光地毯、窗边），Q 版小桃子只露上半身、高脚凳被画框裁掉；同工位合并 `×N`，已结束/空闲汇总成纸签；点任意一格打开协作面板。
- [LeftPage.tsx](../../src/renderer/src/book/LeftPage.tsx)：有帮手时不再自动拉远，默认保留近景；切到整房远景时隐藏分镜条；“看看房间/回到桌前”仍手动可用。
- [CollaborationPanel.tsx](../../src/renderer/src/book/CollaborationPanel.tsx)：没有帮手、任务或页签时把“协作”收成页角小点（aria 名仍为“协作”，面板结构不变）。

### 界面、新手流与设置（文档 04）

- [RightPage.tsx](../../src/renderer/src/book/RightPage.tsx)：顶栏死文字换成可点的「开启专注」（25 分钟 × 1/2/4，沿用既有草案确认流程）；删除输入框内重复的插件拼图；「滤芯」改为「隐私保护中」；第三方原文提示改成人话。
- [LeftPage.tsx](../../src/renderer/src/book/LeftPage.tsx)：三态门牌改成单开关「常伴 / 安静陪着」。
- [Starters.tsx](../../src/renderer/src/book/Starters.tsx)、[cards.tsx](../../src/renderer/src/book/cards.tsx)、[ContinuousWorks.tsx](../../src/renderer/src/book/ContinuousWorks.tsx)+[work.css](../../src/renderer/src/book/work.css)：去掉测试味开场与黑话，工作卡卡片化。
- [MemoryControls.tsx](../../src/renderer/src/tools/MemoryControls.tsx)、[MemorySettingsControls.tsx](../../src/renderer/src/tools/MemorySettingsControls.tsx)、[LifeControls.tsx](../../src/renderer/src/tools/LifeControls.tsx)、[UserSettings.tsx](../../src/renderer/src/tools/UserSettings.tsx)、[tools.css](../../src/renderer/src/tools/tools.css)：主视图只留“她记得的事”和状态；维护操作、向量/镜像、生活明细收进视觉弱化的折叠区（为兼容现有自动化，`details` 默认展开）；「让她休息」→「让她睡会儿」，「我已经有一本书了」→「导入并恢复存档…」。
- [OnboardingPage.tsx](../../src/renderer/src/onboarding/OnboardingPage.tsx)、[onboarding.zh.json](../../src/renderer/src/voice/onboarding.zh.json)：模型步骤默认展开填写卡片，初见台词不再像日式客服。
- 相应脚本按新界面更新：`smoke-state-routing.mjs`（门牌改为 dispatch + 状态断言）、`smoke-sleep.mjs`（按钮改名）、`team-room-preview.mjs`（先手动打开整房远景）。新增 `scripts/smoke-real-spend.mjs` 作为有界真实花费验收入口。

## 2. 验证

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json` | 通过（无输出） |
| `npx eslint .` | exit 0 |
| `npx vitest run` | 145 个文件通过、2 个跳过；1014 项通过、8 项跳过（跳过的是真实 PostgreSQL 集成，与本次无关） |
| `pnpm build` | 通过（electron-vite） |
| `smoke-state-routing.mjs` | 通过（文本状态交接、手动门牌、过期拒绝、重启不重放、时钟工具往返；6 次本地合成请求） |
| `smoke-pomodoro.mjs` | 通过（计划、SQLite 截止、重启、双窗口、迷你窗等） |
| `smoke-onboarding.mjs` | 通过（表单、重启预填、完成、重置、已经有一本书的导入恢复、合成上下文分层） |
| `smoke-settings.mjs` / `smoke-memory.mjs` / `smoke-collaboration.mjs` | 通过（读取、原生拒绝、记忆审阅与压缩、协作家族与重启） |
| `node scripts/smoke-package.mjs --unpacked-only`（`LCA_TEST_DATA_ROOT=D:\.lca-test-data`） | 通过：哈希与 asar 清单、原生 SQLite、`sqlite/journal/pomodoro/backup/memory/life/documents/questions/dsh-spike` 探针、界面重启、`smoke-history`，以及 `model-routing` 起 34 个产品场景（含 `plugins`、`room`、`settings`、`collaboration`、`v12-recovery`）。报告 `test-results/package-unpacked-report.json`；未安装。 |
| `smoke-room.mjs` / `smoke-sleep.mjs` / `smoke-life-work.mjs` | 通过（`LCA_TEST_DATA_ROOT=D:\.lca-test-data`）。第一次用默认工作区路径运行时，这三个脚本的私人存档导出返回 `internal`；把测试数据根换到短路径后全部通过。根因是工作区路径 `C:\Users\…\.codex\worktrees\lca-continuous-work-p0\love, college&agent` 本已很长，开发者档案再嵌套 `developer/<scene>/` 并把 SQLite 备份写进 `.backup-staging/<uuid>/`，超过 Windows 260 字符；属 [continuity.12 已知限制](../CHANGELOG.md)（数据目录过长时探针失败），与本次改动无关，默认用户目录约 130 字符不受影响。 |

新增或扩展的单元测试：`tests/unit/life-tools.test.ts`（自定义去向、提前回来、拒绝重复外出、作息工具）、`tests/unit/diary.test.ts`（折页一晚后解锁、手动补写立即解锁）、`tests/unit/life-reference.test.ts` 等既有断言全部保留。

## 3. 真实模型与花费额度验收

使用本机 profile `%APPDATA%/love-college-agent/connections/providers.json`（chat = `gemini-4-argon`；background/privacy 跟随主模型；work 独立）。只读配置，未在报告中输出任何密钥或原文。

1. **零请求就绪核对**（`scripts/probe-live-readiness.mjs`）：`chat/background/privacy/gifts` 已配置，启动后 **0 次模型请求**。
2. **有界花费验收**（`scripts/smoke-real-spend.mjs`）：临时隔离档案、真实产品路径发送 1 轮聊天；`modelAttempts=1`、`modelSuccesses=1`、`reservedUnits=16000`、报告 token 16,229、账本 `totalReservedUnits=16000`、`autonomousReservedUnits=0`，回复未泄漏控制协议。
3. **人设深度复测**（一次性临时脚本，已删除）：同一配置再发 1 轮深层话题（“做很多事没有意义”），回复 658 字，按新卡完整展开（无常/苦甜、不点名房间道具、不报备树叶数量），并正确使用当前时间；本轮 `reservedUnits=16000`、报告 token 16,696。原文只在本机临时档案，已删除，不进入仓库。

合计：**2 次真实模型尝试，32,000 预留单位，报告 token 32,925**；只用了 chat 槽位（gemini-4-argon），未触发 background/privacy/work 槽位；未使用真实邮件、向量、礼物或校园服务。

## 4. 打包

- 命令：`LCA_PACKAGE_VERSION=1.2.0-experience.1 node scripts/package-win.mjs --reuse-prepared-runtime`（复用已准备的 `dsh/runtime`，其余按仓库脚本；`electron-builder` 使用本机已有缓存，未下载浏览器或额外工具）。
- 产物：`release/Love-College-Agent-1.2.0-experience.1-Setup.exe`，315,492,345 字节，SHA-256 `256a0f647b1ebbeb24539408d232f836463069c83515680d994398451e5f7fef`；`app.asar` SHA-256 `d5eb881432029ea4b55c1f9effb6f67bd607344ca4746905dc19cb91519172e9`。回执见 `release/build-receipt.json`（`sourceRevision` 为基线 `6a86e1b`，`trackedDirty: true`，表示工作区有未提交改动）。
- 包内验收：`node scripts/smoke-package.mjs --unpacked-only`（`LCA_TEST_DATA_ROOT` 指向短路径）通过哈希、asar 文件清单、原生 SQLite 和包内 EXE 场景；**未安装、未覆盖已有安装、未发布**。
- 磁盘：开始时工作区所在 C: 仅剩约 0.2 GiB；维护者清理后约 2.7 GiB，打包前约 3.5 GiB，构建与安装器生成完成后约 2.3 GiB，未触发“容量不足”。此前一次包内矩阵在 `smoke-history` 的私人存档导出失败，是同一 260 字符长路径问题；改用 `D:\.lca-test-data` 后通过。

## 5. 未做与边界

- 世界泡只做了止血和主动权归还，没有重做“每日自主小念头/生活片段生成”；`empty.png + 手写便签` 的多样化去向已可用，但日程页之外的长期生活叙事仍待下一轮。
- `Mirror` 工具未加入：当前没有换装/换场景的可塑性，截图只会重复同一张立绘，因此按讨论留到世界泡重做后再考虑。
- 默认闭合的“高级”折叠区为了兼容现有自动化保持 `open`；彻底收起需要同步改多个 smoke 脚本，另行决定。
- 本机工作区的深层路径加上开发者档案嵌套会让私人存档的 SQLite 临时备份超过 Windows 260 字符，测试需把 `LCA_TEST_DATA_ROOT` 指到短路径；这是既有的长路径限制，默认用户目录约 130 字符不受影响。
- 本次未提交、未发布、未安装；真实模型验收只覆盖 2 次有界聊天，不代表长期日用。

## 6. 维护者审阅后的改动（2026-11-05）

审阅时在同一分支上又改了几处，随后分组提交：

- 测试数据目录：Windows 上 `LCA_TEST_DATA_ROOT` 未设置时，合成 profile 默认放到盘根 `<盘符>\.lca-cache\data`。上一节的路径问题不再需要手动指定短路径。
- 门牌：专注中把牌子翻回常伴，原实现会直接提前结束这一段；现在先弹一句确认，点别处、按 Esc 或“继续专注”都不改变计时。
- “关于你”：用户是什么样的人改由用户自己写，入口在新手流程（可跳过）和设置「称呼与关于你」。角色卡不再描述用户，一律称“对方”。
- 人设：写明成年；被问是不是 AI 照实说是；边界只冷静拒绝或退开；尾置提醒不写具体性格。裁定见[文档 01](experience-polish-01-persona-and-prompt-20261105.md) 2.1 节。
- 日记折页：维护者决定保留现有实现。只有她自己动笔时偶尔折页，最多晚 18 小时；手动请她补写的立即可读。计划里的「请她现在翻开」按钮和“聊天中答应后再打开”没有做。
- 验证：类型检查、lint、构建与 1017 项单元测试通过（8 项跳过）；`test:pomodoro`、`test:onboarding`（含仅后端）通过；`test:room`、`test:sleep`、`test:life-work`、`test:history` 在新的默认测试目录下通过。第 2–4 节的包内验收、真实模型请求和安装器都在这些改动之前，不覆盖它们。

## 7. 维护者实测：卡顿根因与修复（2026-11-05）

维护者反馈“巨卡”：启动、最小化恢复白屏，窗口缩放卡顿，设置页滚动不利索。用真实 profile 的副本（不改日用数据）复测，现象可稳定复现，且属于既有连续性代码的问题，不来自本轮界面改动。

### 复测与定位

| 指标（修复前） | 数值 |
| --- | --- |
| 启动到窗口可见 | 42–72 秒（同一份档案；全新档案约 1.7 秒） |
| 主进程事件循环延迟（`setImmediate`） | 2.4–7.4 秒 |
| 主进程 CPU | 约 262% |
| `getSnapshot` IPC | 2.5–5.3 秒 |
| `dispatch`（如熄灯） | 5–10 秒 |
| 窗口缩放后 rAF 帧间隔 | 约 1006 毫秒/帧 |
| 最小化恢复首帧后间隔 | 约 1016 毫秒 |
| 渲染进程空闲帧 | 60fps（p50 6.1 毫秒），说明不是绘图问题 |

主进程 CPU profile（Node inspector）显示 96% 的样本落在 `store.history()` 的 `structuredClone` 调用链：`publish()` 每秒和每次交互都重建各服务视图，而 `memory.sessionView()`、`gifts.view()`（`giftSources` → `sources` → `visible`）、`quill`、`photos` 等都会读取 `store.history()`；该函数每次都 `structuredClone` 全部经历，内部又克隆当天记录，档案越大越慢。

### 修复

`journal.records()` 与 `store.history()` 改为维护一份冻结的只读视图，只在 `append` / `rotate` 后失效；调用方本来就只读（没有写回或就地修改）。共 12 行改动，[file.ts](../../src/main/journal/file.ts)、[session.ts](../../src/main/store/session.ts)。

### 修复后（同一份档案副本，开发者构建）

| 指标 | 修复后 |
| --- | --- |
| 启动到窗口可见 | 1.9–2.0 秒 |
| 主进程事件循环延迟 / CPU | 0.1–0.3 毫秒 / 5.5% |
| `getSnapshot` / `dispatch` | 0.7–1.2 毫秒 / 25–37 毫秒 |
| 打开设置页 | 218 毫秒（此前 18.4 秒） |
| 设置页滚动帧间隔 | p50 6.1 毫秒 |
| 缩放的帧间隔 / 恢复 | p50 6.1 毫秒、最大 24 毫秒 / 首帧 3.5 毫秒、最大间隔 11.7 毫秒 |
| 安装版启动（`1.2.0-experience.2`） | 窗口 2.01 秒 |

安装器：`Love-College-Agent-1.2.0-experience.2-Setup.exe`，315,493,770 字节，SHA-256 `66951cf763ce66a79c661a5d2d71a6c653bd6794f0042f95b6d290925b37fc45`，asar `29999e71333a1ceb872ff1f291bff2d2ecb799c9c16ac3dadefc9755bbc04c03`，源码 `941ee93`（干净工作区）；已覆盖安装本机默认目录。类型、lint、1017 项单测在修复后重跑通过。未发布。

## 8. 维护者实测：笔记预算卡住日记（2026-11-05）

维护者看到日记页显示“本日的运行预算已到上限”，并问在哪里加预算。查明：

- 真实档案的模型日 `2026-11-05` 从 04:00 起，约 71 秒一次、每次约 6.2k 单位的**自主**后台请求连续 15 次（04:00–04:16），把默认自主日额度 100,000 用到 94,486；下一次准入触发 `budget-exceeded`，此后日记的自动/手动写入都失败。当天日志前后有 32 条 `memory/operation`，对应日切后的记忆整理与日记补写。
- 旧实现只有展位模式能改预算；普通用户没有任何入口，默认额度又不足以覆盖一次日切维护，于是日记在当天剩余时间全部不可写。
- 修复分两层：
  1. **准入只约束自发行为**：只有她自发的后台调用进入自主额度并按用途分项（记忆 50%、日记 20%、邮件/书桌/其他各 10%）；用户发的消息、点「请她补写」、主动要求整理记忆与连接测试都是 `work` 记录，只记用量、不会被自主额度拒绝；展位操作者设置的总量封顶仍约束所有回合。「请她补写」也不再受自动重试每天 3 次的限制（自动重试仍受限制）。
  2. **额度可改且够用**：默认值改为总日 800,000 / 自主日 300,000；普通用户可在「设置 → 用量与实验 → 运行资源」修改并保存，界面显示自主分项的实际用量与分项上限。仍保留账本只追加、失败不退款、坏账本关闭请求等约束。

实测：真实档案 04:00 后自主已用 94,486，新默认 300,000 下重试可再次准入；`tests/unit/resources.test.ts`、`tests/unit/diary.test.ts`、`tests/unit/task-model-ports.test.ts` 与完整 1017 项单测通过；`smoke-resources` 按新策略（普通模式可配置、个人回合不被自主预算挡住、坏账本仍关闭请求）更新并通过。

后续重构方向（未做）：把分项比例做成可调的独立上限，并让界面能回答“今天哪类后台活动花了多少、为什么停了”；日切维护类调用可考虑单独计量，不再与日记共用叙事。

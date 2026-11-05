# 执行文档 04：主界面、新手流与设置页交互重构方案

- **所属总纲**：[体验与灵魂升级总纲](experience-polish-master-plan-20261105.md)
- **目标**：清理所有“黑客松临时测试按钮、生造黑话、三态门牌混淆、设置页裸排控件与数据库字段外露”，建立符合现代桌面软件直觉且保持绘本书本美学的交互。

---

## 1. 主界面（左页 & 右页）交互改造清单

### 1.1 右页顶栏：把死文字 `今天还没排番茄` 变成可点击的轻量「开启专注」入口
- **位置**：[src/renderer/src/book/RightPage.tsx:308–350](../../src/renderer/src/book/RightPage.tsx#L308-L350)（`PlanHead`）
- **现状问题**：平时显示死文字 `今天还没排番茄`，不能点击；用户去日程页想开番茄钟，还要先点 `生成待确认计划` 再点 `确认计划` 再点 `开始专注`，极其反人类。
- **修改方案**：
  - 当没有正在进行的计划时，右上角显示一个温和可点的胶囊按钮 **`「开启专注」`**（附小钟表线条图标）。
  - 点击 **`「开启专注」`** 展开一个轻巧的纸签气泡：`[25 分钟 × 1]`、`[25 分钟 × 2]`、`[25 分钟 × 4]`。
  - 用户点选任一项后，前端按顺序自动派发 `pomodoro.plan`（如果尚无确认计划，也可在日程页一键确认并启动），让用户真正能从右上角直接发起专注；如果当前已有待确认草案（`pomodoro.proposal`），点击右上角 `「计划等你确认」` 直接弹出或确认并开始。

### 1.2 左页门牌（`DoorSign`）：废除三态木牌，改为单开关「安静陪着」
- **位置**：[src/renderer/src/book/LeftPage.tsx:232–274](../../src/renderer/src/book/LeftPage.tsx#L232-L274)
- **现状问题**：`工作中 / 安静 / 休息` 三态门牌在持久工作分离后已失去路由意义，且“休息”与番茄钟休息、设置页睡觉严重重名。
- **修改方案**：
  - 将门上的 `DoorSign` 改造为轻量的单状态切换签：
    - 正常状态（`mode !== 'quiet'`）：平时半透明收敛，显示 **`「常伴」`**（悬停提示：*“她会在合适的时候和你说说话；点击切换为安静陪着”*）；
    - 安静状态（`mode === 'quiet'`）：显示 **`「安静陪着」`**（悬停提示：*“免打扰：她只回应你的话，暂停主动搭话与语音；点击恢复”*）。
  - 一键切换 `quiet` 与 `rest`（保留下拉小菜单或辅助入口以兼容可能直接找 menuitemradio 的旧自动化脚本，但主交互为一键切换「安静陪着」）。

### 1.3 右页输入框（Composer）与卡片文案净化
- **位置**：[src/renderer/src/book/RightPage.tsx:225–264](../../src/renderer/src/book/RightPage.tsx#L225-L264)、[cards.tsx](../../src/renderer/src/book/cards.tsx)、[ContinuousWorks.tsx](../../src/renderer/src/book/ContinuousWorks.tsx)
- **修改方案**：
  1. **移除输入框内的拼图 `[插件]` 按钮**（右侧书签栏已经有常驻的「插件」书签，输入框内不再重复摆放）。
  2. **改造 `滤芯` 标签**：将不知所云的 `滤芯` 二字改为直观的 **`隐私保护中`**（带小盾牌/锁图标，悬停解释：*“拖入的资料与邮件原文先经隐私脱敏处理”*）。
  3. **美化 `ContinuousWorks.tsx`（「手上的工作」卡片）**：
     - 补齐 `src/renderer/src/book/work.css` 样式：使用与书本卡片一致的暖白纸张背景、圆角边框、状态徽章与精巧的小按钮（`[继续]`、`[暂停]`、`[停止]`），告别浏览器默认 `<details>` + `<ul>` 裸列表。
  4. **卡片黑话翻译**：
     - [cards.tsx:66](../../src/renderer/src/book/cards.tsx#L66)：`把原文放进这一轮` → 改为 **`发给她看原文`**；
     - [RightPage.tsx:184](../../src/renderer/src/book/RightPage.tsx#L184)：`本轮含第三方原文：写文件、执行命令、外发和付费都会逐次批准，且不能新建或扩大授权。` → 改为 **`她刚读了外部原文：为安全起见，这一轮改文件或运行命令前都会先问过你。`**

---

## 2. 新手指引（`OnboardingPage`）与首次引导气泡（`Starters`）

1. **新手指引初见台词重写（[onboarding.zh.json:74](../../src/renderer/src/voice/onboarding.zh.json#L74)）**：
   - 原文：`“{userName}，你好。我是{characterName}，书桌已经收拾好了，以后请多指教。”`（日式客服味）
   - 改为：**`“……嗯，{userName}，你好。我是{characterName}。既然把这间屋子画好了，以后你想做事或者想待一会儿，我都在。”`**
2. **新手指引第 2 步「接上模型服务」（[OnboardingPage.tsx:40](../../src/renderer/src/onboarding/OnboardingPage.tsx#L40)）**：
   - 将 `filling` 初始状态设为 `true`（在有 runtime 时默认直接展开 API 地址与密钥填写卡片），不再让用户先面对空页面去找按钮；将 `选择模型配置文件` 弱化为次要按钮。
3. **首次对话引导气泡（[book.zh.json:235–239](../../src/renderer/src/voice/book.zh.json#L235-L239)）**：
   - 将测试味十足的 `“在书桌上帮我写个小程序，数数 1 到 1000 之间有多少个质数，跑一遍给我看结果。”` 改为更自然实用的选项（如：`“选一个我的项目文件夹”`、`“帮我理一下今天的安排”`、`“随便聊聊，认识一下”`）。

---

## 3. 设置页（`UserSettings`）视觉卡片化与工程项折叠

### 3.1 统一卡片化样式（`src/renderer/src/tools/tools.css`）
- 为 `.settings-group[open]` 及各 `*Controls` 子区块引入统一的纸张卡片样式（背景 `color-mix(in oklab, var(--paper) 88%, white)`、细边框 `1px solid color-mix(in oklab, var(--pencil) 45%, transparent)`、圆角 `10px`、内边距 `14px 16px`），让输入框有清晰的圆角底框而非悬空的下划线，按钮分清主次。

### 3.2 修正迷惑文案与收纳工程运维控件
1. **`BackupControls.tsx`**：
   - 将恢复按钮文案从 **`我已经有一本书了`** 改为 **`导入并恢复存档…`**（保留 `aria-label` 或测试可识别属性）。
2. **`LifeControls.tsx`**：
   - 将 **`让她休息`** 明确改为 **`让她睡会儿`**（对应 `唤醒她`）；
   - 将 `2026-11-04 · 房间 · 虚构生活，离线不代表实际工作` 改为干净的当前状态说明：`当前在房间 · 闲暇时她会有自己的日常`；
   - 将带有 `outingId.slice(-8)` 哈希的物品调试列表与 `放入合成阅读材料 / 开始今日阅读 / 开始今日写作` 收进 `<details className="settings-advanced"><summary>生活与书桌作品详情</summary>...</details>` 中。
3. **`MemoryControls.tsx` & `MemorySettingsControls.tsx`**：
   - 主视图直接展示最重要的 **「她记得的事（`MemoryFactsControls`）」**（审阅、纠正、忘记、手动添加记忆）；
   - 将 **`向量服务（Embedding）与外部数据库镜像（PostgreSQL）`** 收进 `<details className="settings-advanced"><summary>高级：向量检索与外部数据库同步</summary>...</details>`；
   - 将 **`[保存当前场景照片] [抽取可见经历] [归并已结束周期] [压缩旧回合] [检查翻页条件]`** 以及旧版 `memory.items` 调试列表收进 `<details className="settings-advanced"><summary>维护操作与历史日页查阅</summary>...</details>`。
4. **`PluginCenter.tsx`**：
   - 文案与分类梳理：将内置开关区块标题从生硬的“内置”明确为“书房伴随能力”，外部插件与 MCP 保持清晰分组。

---

## 4. 自动化测试兼容性核对清单

为确保 `scripts/smoke-*.mjs` 在 Electron 自动化测试中不会因为 `<details>` 折叠找不到按钮：
- 核对 `smoke-memory.mjs`、`smoke-memory-mirror.mjs`、`smoke-settings.mjs`、`smoke-room.mjs`、`smoke-backup.mjs` 中的选择器：
  - 若某个测试脚本直接 `click('button:has-text("...")')` 且不会先展开嵌套 `<details>`，则将该容器设为视觉上弱化折叠（或在开发/测试环境下默认 `open`），确保 **人类日常使用看到的是清爽界面，自动化回归 100% 绿灯通过**。

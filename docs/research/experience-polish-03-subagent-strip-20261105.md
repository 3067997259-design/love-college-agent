# 执行文档 03：子代理「手账特写分镜条」可视化方案

- **所属总纲**：[体验与灵魂升级总纲](experience-polish-master-plan-20261105.md)
- **目标**：
  1. **永远保住左页大桃子近景**：不再因为启动了 1 个或多个 subagent / teammate 就强行切走近景大桃子（保留她最好看的侧脸思考与表情差分）。
  2. **用「左页底部手账特写分镜条（SubagentStrip）」取代伪 3D 地面贴纸**：复用 `room-day.webp` 的局部切片作为每个分镜格的背景（书架绿植、木桌电脑、阳光地毯），将 Q 版小桃子下半身的高脚凳裁出画框外，彻底消灭透视穿模与画风割裂。
  3. **从容应对 8+ 并发智能体**：采用「最多 3 格活跃焦点（Spotlight）+ 同工位叠纸徽章 + 已完成/空闲折叠胶囊」，无论开多少个子代理都井然有序。

---

## 1. 为什么切换默认镜头策略？

在现有代码 [src/renderer/src/book/LeftPage.tsx:83–88](../../src/renderer/src/book/LeftPage.tsx#L83-L88) 中：
```ts
const helpers = teamMembers(snapshot.collaboration)
const helpersActive = teamActive(helpers)
const team = teamPossible && (manualShot ? manualShot === 'team' : helpersActive)
```
只要 `helpersActive` 为 `true`，`team` 就自动变成 `true`，直接把左页的 `WashRoom`（近景大桃子）盖住，换成全房间远景 `TeamRoom`。
- **修改后**：
  - 默认视角始终为 `'close'`（近景大桃子）：`const team = teamPossible && manualShot === 'team'`。
  - 当 `helpers.length > 0` 时，在左页底部浮现 **`<SubagentStrip />`（手账特写分镜条）**。
  - 用户如果想看全房间远景（或自动化测试脚本点击切换按钮），点分镜条旁边的 `「看看房间 / 回到桌前」` 即可手动切过去。

---

## 2. 「手账特写分镜条（SubagentStrip）」视觉与交互设计

### 2.1 布局结构（位于左页底部 `.page-left` 内，`z-index` 高于近景画布，不遮挡大桃子的脸和上半身）

```
+-------------------------------------------------------------------------+
|                        [ 左页：大桃子近景书桌 ]                         |
|                                                                         |
|                                                                         |
|  +--------------------+  +--------------------+  +--------------------+ |
|  | [书架局部背景]     |  | [木桌电脑局部背景] |  | [阳光地毯局部背景] | |
|  | (Q版翻书半身像)    |  | (Q版打字半身像)    |  | (Q版举纸条半身像)  | |
|  | 查资料 · explore-1 |  | 改文件 · coder  ×2 |  | 等你批准 · tester  | |
|  | 正在搜 src/main    |  | LeftPage.tsx · 12s |  | 运行测试命令       | |
|  +--------------------+  +--------------------+  +--------------------+ |
|                                       [已完成 3 · 空闲 1]  [看看房间]   |
+-------------------------------------------------------------------------+
```

### 2.2 每个工位种类（Station / Pose）的局部背景切片映射

每个分镜格是一个约 `156px × 84px` 的圆角手账纸片画框（带柔和的纸白内边框 `#fbf5e8`、细铅笔外框与微阴影，左侧 `64px × 72px` 为带 `room-day.webp` 局部背景的小画窗，右侧为名字、动作与耗时）：

| 子代理状态 / 焦点 | 选用的 `room-day.webp` 局部切片 (`background-position` / `background-size`) | 选用的 Q 版精灵图 (`mini-v2-*`) | 画面裁切效果（消除违和感的关键） |
| --- | --- | --- | --- |
| **写代码 / 改文件 / 跑命令** (`typing` / `files`) | **茶桌/书桌木质台面与柔光背景**（`background-size: 380%; background-position: 32% 72%`） | `stool-end-right` 或 `note-right` + 桌面 `prop-laptop-side` | **画窗下沿正好卡在桌面高度，把底下那根高脚方凳 100% 裁在画窗外！** 画面里只有小桃子上半身在木桌笔记本前专注打字，完全自然。 |
| **查资料 / 搜索 / 读文件** (`reading` / `research`) | **书架中层（彩色书脊 + 垂吊绿植）**（`background-size: 340%; background-position: 18% 42%`） | `shelf-reach` 或 `reading-back` / `note-left` | 书架局部放大后，书本线条粗细与 Q 版小桃子完全吻合，像在书架前特写抓拍的一格漫画。 |
| **协调 / 传递消息** (`carrying` / `team`) | **窗台暖光与小盆栽一角**（`background-size: 360%; background-position: 56% 38%`） | `note-left` / `note-right` | 拿着便签在窗边走动。 |
| **等你批准 / 等你回答** (`waiting`) | **洒满百叶窗阳光的浅紫地毯**（`background-size: 360%; background-position: 62% 88%`） | `waiting`（举纸条） | 暖色高亮边框提醒，一眼看到她在等你批准。 |
| **思考中** (`thinking`) | **窗边天空柔光局部**（`background-size: 360%; background-position: 68% 28%`） | `thinking`（托腮） | 安静思考。 |
| **出错 / 未完成** (`failed` / `stopping`) | **地毯暗部局部**（`background-size: 360%; background-position: 75% 88%`） | `failed`（摊手） / `stopping` | 醒目但温和的提示色。 |

- **光影同步**：分镜小画窗直接继承 `.room` 的日夜滤镜（夜晚模式下局部背景和小桃子自动染上台灯暖光与夜色蓝调，不再刺眼）。

### 2.3 高并发（8 个 Team 成员或 10+ Subagents）防乱机制

当 `helpers.length > 3` 时，如何保证左页底部永远最多只显示 **3 张分镜格**？

1. **注意力优先级排序（Priority Sorting）**：
   - **P0（最高）**：`waitingFor === 'approval' | 'user'`（等你操作）或 `memberFailed(member)`（出错待处理）；
   - **P1（次高）**：`activity === 'running' | 'starting' | 'stopping'`（正在干活），按同工位去重优先展示不同工位的代表，同工位多人的在分镜右上角叠加 **`×N` 叠纸徽章**（卡片底部露出两层错位纸边，表示这一沓有 N 个帮手在干同类活）；
   - **P2（退居幕后）**：`activity === 'inactive'`（已完成 `completed` 或空闲 `idle`）的成员，在还有活跃成员时**自动让出分镜格**，汇总进右下角的轻量胶囊 **`「已完成 M · 空闲 K」`**。
2. **点击交互**：
   - 点击任意一张分镜格：就在该分镜格上方弹出美化后的 `MemberCard`（显示最近步骤、耗时、结果与「停止当前工作」按钮）；
   - 点击叠纸徽章或底部的汇总胶囊：展开整理后的协作成员抽屉，可查看全部成员或发送新指令。

---

## 3. 对既有测试与组件的兼容性保护

- 保留 `TeamRoom.tsx` 组件与 `.collaboration-shot`（`看看房间 / 回到桌前`）按钮：当用户或 `scripts/team-room-preview.mjs`、`scripts/smoke-collaboration.mjs` 点击切换时，依然可以打开 `TeamRoom` 并通过所有选择器检查。
- 平时无任何帮手（`members.length === 0`）且未打开面板时，左页右下角的 `[协作]` 按钮默认收起为极低存在感或按需显现，不破坏书房画面的纯粹感。

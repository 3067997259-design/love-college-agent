# 体验与灵魂升级总纲（Experience & Persona Polish Master Plan）

- **日期**：2026-11-05
- **工作分支**：`codex/experience-polish`（基于 `codex/continuous-work-p0` 基线 `6a86e1b`）
- **核心目标**：消除黑客松 48 小时开发遗留的“AI 味、防御性法条腔、僵尸感世界泡、反直觉按钮、画风割裂的远景贴纸、工程控制台式的设置页”，在 100% 保持底层安全/持久化/连续协作（DSH + AIRI 记忆）能力与自动化回归兼容的前提下，让桃子真正活过来，让软件符合人类直觉。

---

## 1. 已拍板的核心设计决策

| 议题 | 最终决定 | 对应执行文档 |
| --- | --- | --- |
| **桃子人设与 Prompt 架构** | 迎回原卡 `ReLU` 的文学灵魂（沉默作为容器、矛盾共存、苦甜交织的无常觉知、冷幽默、锋利边界、**浅层寒暄留白 / 深度对话全情投入**），赋予阮·梅式“任是无情也动人”的克制美；剥离 `JSON.stringify` 外壳，加入尾置人格锚点，禁止复读与机械点名房间道具。 | [01-人设灵魂与Prompt架构执行方案](experience-polish-01-persona-and-prompt-20261105.md) |
| **世界泡与日记系统** | **世界泡**：开放自定义去向（无专用外景图时使用 `empty.png` 空房 + 她亲笔留下的自定义去向便签），降低必掉贝壳/树叶的机械概率，为桃子接通 Chat 内的生活控制工具，砍掉日程页僵尸打卡表与傀儡遥控按钮。<br>**日记**：去掉“主观日记”首行与大红印章，移除日记页底部的 16 位十六进制 ZIP 密码外露；允许她写日记时偶尔标记“先折起来自己留着（shy）”，隔天或在对话里答应你后才落钥匙。 | [02-世界泡与日记活人化执行方案](experience-polish-02-world-and-diary-20261105.md) |
| **子代理团队可视化** | **默认锁死大桃子近景**（保住最佳表情差分与侧脸思考）；在**左页底部**新增「手账特写分镜条」（最多 3 格活跃焦点 + 叠纸计数胶囊），复用 `room-day.webp` 的局部切片（书架绿植、木桌电脑、阳光地毯）做每个分镜的背景，把高脚凳自然裁出画框外；保留一键切换全房远景的开关。 | [03-子代理手账分镜可视化执行方案](experience-polish-03-subagent-strip-20261105.md) |
| **主界面、设置页与新手流** | **右页顶栏**：“今天还没排番茄”改为可点击的轻量「开启专注」快捷入口；<br>**左页门牌**：三态木牌（工作中/安静/休息）改为轻量的单开关「安静陪着」；平时无帮手时隐藏「协作」按钮；<br>**输入框与卡片**：移除重复的拼图「插件」按钮，优化「滤芯」与工作目录签，将“把原文放进这一轮”等黑话改回人话，美化 `ContinuousWorks` 卡片；<br>**设置页**：卡片化视觉重构，将内部运维按钮（抽取/压缩/翻页/向量迁移/镜像连接/预留单位/哈希列表）收进默认闭合的「高级与调试」折叠区，修正“我已经有一本书了 / 让她休息”等迷惑按钮文案。 | [04-界面交互与设置重构执行方案](experience-polish-04-ui-and-settings-20261105.md) |

---

## 2. 施工顺序与提交边界（遵守 AGENTS.md）

按照 [AGENTS.md](../../AGENTS.md) 约定（共享接口改动单独提交且标题以 `接口：` 开头；按改动运行相关检查）：

1. **阶段 1（包 01：人设与 Prompt 架构）**
   - 修改 `src/main/characters/taozi.zh.json`、`src/main/harness/policy.json`、`src/main/index.ts`、`dsh/lca-bridge/state.js`、`src/main/life/reference.ts`。
   - 验证：`pnpm typecheck`、`pnpm lint`、`npx vitest run tests/unit/builtin-persona.test.ts tests/unit/onboarding.test.ts tests/unit/life-reference.test.ts`。
2. **阶段 2（包 02：世界泡与日记活人化）**
   - 若涉及 `src/shared/` 类型扩展（如日记 `shy` 状态提示、自定义外出地点文案字段），先单独提交 `接口：...`。
   - 修改 `src/main/life/`、`src/main/diary/`、`src/renderer/src/book/sheets/DiaryBook.tsx`、`src/renderer/src/book/LeftPage.tsx`。
   - 验证：`npx vitest run tests/unit/life.test.ts tests/unit/diary.test.ts`。
3. **阶段 3（包 03：左页底部子代理手账分镜条）**
   - 修改 `src/renderer/src/book/LeftPage.tsx`、`src/renderer/src/book/CollaborationPanel.tsx`，新增 `src/renderer/src/book/team/SubagentStrip.tsx` 与对应样式，保留 `TeamRoom.tsx` 供手动切换与既有预览脚本兼容。
   - 验证：`pnpm typecheck`、`pnpm lint` 及团队协作相关单测。
4. **阶段 4（包 04：主界面、日程页、新手引导与设置页大扫除）**
   - 修改 `RightPage.tsx`、`ScheduleSheet.tsx`、`OnboardingPage.tsx`、`Starters.tsx`、`ContinuousWorks.tsx`、`UserSettings.tsx`、`MemoryControls.tsx`、`LifeControls.tsx`、`BackupControls.tsx`、`tools.css` 及 `voice/*.zh.json`。
   - 验证：`pnpm typecheck`、`pnpm lint`、`pnpm test` 全量单测与构建检查 `pnpm build`。

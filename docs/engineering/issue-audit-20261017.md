# GitHub Issue 自动巡检与修复（2026-10-17 02:05–02:30）

来源为本仓库 GitHub Issues。本轮先用只读核实员独立判定真假，再按仓库门槛修复。审计基线 `628ae73`，修复合入 main 至 `299e11a`。核实结论与修复证据分开列，不混作同一次验收。

后续轮次见下方「第二轮」，以及 [第三轮记录](issue-audit-round3-20261017.md)。

## 判定与处理

| 问题 | 核实判定 | 处理 |
| --- | --- | --- |
| [#6 房间路径迁移后普通升级无法访问已有书桌](https://github.com/3067997259-design/love-college-agent/issues/6) | 真，但**可达性与严重度需下修**：旧路径只在 `0145f7b`(00:43)→`3e57632`(00:54) 这 11 分钟存在，两个安装包都早于它；现场目录 `Documents/桃子的房间/2be6da680dca` 下没有任何文件 | **不关闭**，评论反证与剩余缺口（一次性迁移仍未实现）；`#8` 的持久化布局已补上「静默搬家」的前半段 |
| [#7 最近七天日摘要占满上限，较早周／月摘要进不了上下文](https://github.com/3067997259-design/love-college-agent/issues/7) | 真，且比 issue 更重：宽摘要先入选、压制了它覆盖的日摘要，随后自己被 `slice(0, 7)` 丢弃，那段经历**零代表** | 修复 `bb054d6`，合并 `b39e5d9`，已关闭 |
| [#8 不同正常 profile 共用同一个房间和书桌](https://github.com/3067997259-design/love-college-agent/issues/8) | 真，随时可触发，不需要并发 | 修复 `991ac2f`，合并 `4658983`，已关闭 |
| [#9 恢复旧存档后房间未清理后续日记和礼物](https://github.com/3067997259-design/love-college-agent/issues/9) | 真：`rebuild()` 只写不删，恢复目标不含房间 | 修复 `f8ba1e3`，合并 `299e11a` |

## 修复内容

- **#7**：`summaryReferences` 的单次引用预算改为 12 条，先占满最近七日，余下按「月 → 周 → 更早日摘要」分配；被宽摘要覆盖的日摘要不重复进入。资格窗口（周来源早于 today−7、月早于 today−30）、来源会话去重与 F1 依赖新鲜性守卫（有效性先于去重）未动。
- **#8**：新增 `src/main/room/paths.ts` 作为房间根的唯一构造点。私有基座（developer／booth／显式 `LCA_DATA_DIR`）保持 `<dataDir>/rooms/<ownerKey>`；共享基座改为 `文档/桃子的房间/<ownerKey 前 12 位>-<sha256(realpath(dataDir)) 前 8 位>`。已解析布局经 `roomLayout` 写入 profile 设置并优先复用；记录不属于当前 profile、非绝对路径或版本不符时忽略。
- **#9**：`rebuild()` 改为对账式投影 —— 先按日志算出程序拥有的期望文件集合并原子写入，再删除「日记／礼物／运行记录／带回来的东西」中不在期望集内的普通文件。`书桌`、子目录与托管命名之外的文件一律不删；删除只发生在全部写入成功之后。

## 本轮实跑过的证据

- `pnpm typecheck`、`pnpm lint`、`pnpm test`：每批改动后均重跑，最终 42 个文件／198 项通过。
- 新增回归：记忆饱和用例（18 份日摘要＋2 份周摘要，今天 2026-10-19）先复现失败 — 含 `prepareContext` 的 `previousDaysReference` 断言；`tests/unit/room-paths.test.ts` 6 项（不同数据根不同 root、同 profile 重启与大小写拼写同 root、私有基座不改名、记录复用与外部记录被忽略）；`tests/unit/room-projection.test.ts` 2 项（恢复后清理过期投影且保留书桌／子目录／非托管命名文件、重复重建幂等）。
- `pnpm probe:deeptech-audit` 27 项通过；`pnpm experiment:deeptech-memory --holdout` 未退化（纠正类条目过期 6 → 0，旧会话仍有摘要代表 24/24，真实 `prepareContext` 一致 24/24）。二者只覆盖摘要选择与来源权限，不代表真实模型质量。
- `pnpm test:room`（真实 Electron）：加密日记、用户独占钥匙、原生私人存档导出／导入与投影重生成通过；本轮在同一场景补了「写入不属于日志的过期投影 + 用户书桌文件 → `room.rebuild` 后过期投影消失、书桌文件原样」的断言，重跑通过。
- CI：`b39e5d9`、`4658983`、`299e11a` 的 Engineering checks 均 success。

## 未覆盖边界

- 全部输入为合成数据与 fake 模型；本轮没有真实模型、邮箱、Rodin 调用，也没有安装包重建与 `pnpm test:package`。
- #8 未跑真实 Electron 双 profile 端到端（本 worktree 未安装 Electron 二进制时由只读核实员在沙箱内直接导入 `desk.ts`／`projection.ts` 实算路径代数）；OneDrive 重定向 Documents、并发 rename 覆盖的 Windows 行为、非默认角色包在两 profile 的共用均未验证。
- #9 的「恢复后清理」在 Electron 场景里通过 `room.rebuild` 触发验证；`smoke-room.mjs` 恢复时换新 `sceneId`，因此仍未覆盖「同一数据根上恢复旧存档」的完整时序。
- #6 的一次性迁移未实现；其「11 分钟窗口」结论来自 git 提交时间与 `AGENTS.md` 的安装包时间线，不是端到端复现。
- [#2](https://github.com/3067997259-design/love-college-agent/issues/2) 于 01:51 关闭后又被重新打开，且没有新的复现说明。本轮复核确认 `4952553` 的修复机制仍在位（`src/main/heart-flow/context.ts` 以 sessionId＋全局位置过滤，而非跨日比较 seq），未发现新的反证；等待复现信息后再判定。

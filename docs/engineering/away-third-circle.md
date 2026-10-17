# 外景页：复用视频冻结包的素材（2026-10-17 晚补接）

用户 2026-10-17 晚确认：其他模型接手动画短片，由 GPT 线把 Claude 剩下的一些素材接入做完；下午画好的素材要复用进应用。本文记录外景页这一批（左页＋迷你窗）。

## 范围与边界

- 只改渲染层：外景素材、左页外出状态、迷你窗裁切与预览场景；**没有**改主进程事实、共享接口、命令、隐私或存档边界。
- 地点（`coast`／`swing`）、时段（`daypart`）、外出记录与回来时刻全部只读 `AppSnapshot`；渲染层不按天色或时间自己推。
- 素材来自 [视频素材冻结包](../../art/film-frozen/2026-10-17-v1/README.md)，只复制、不缩放、不改画；冻结包原样保留，没有覆盖或重跑生成。
- 不是“物理重光”：海岸没有夜景重光图，夜里复用白天画面加时段调色，和电脑／交流姿势现有的回退同一种；不因此宣称昼夜差分完成。

## 素材与映射

运行素材：`src/renderer/src/assets/character/taozi/away/`（5 张，来源与哈希见同目录 `manifest.json`）。

| 运行素材 | 冻结包来源 | 用途 |
| --- | --- | --- |
| `coast-day.png` | `selected/v6-19-walk-a.png` | 海边，上午／白天：她撑着透明伞沿海走 |
| `coast-evening.png` | `selected/v6-34-coast-window.png` | 海边，傍晚：海边小街与橱窗 |
| `swing-day.png` | `selected/base-07-k18-under-swing.png` | 秋千，白天：她坐在树下 |
| `swing-evening.png` | `selected/v6-21-swing-arrival.png` | 秋千，傍晚：她坐在秋千上 |
| `swing-night.png` | `selected/base-01-k12-writing.png` | 秋千，夜里：画内夜光，她在秋千上写东西 |

选择逻辑在 `src/renderer/src/book/life/awayArt.ts`：

- 海边：`evening` → coast-evening；`night` 没有重光图，复用 coast-day（ambient 调色）；其余 coast-day。
- 秋千：`night` → swing-night（`baked-night`，不叠时段调色）；`evening` → swing-evening；其余 swing-day。
- 旧地点或自定义地点（如 `shore`）返回 `null`，回退原来的空房间＋桌上纸条；自定义角色包优先包内素材（`packageScene`），不会拿桃子的外景冒充。

## 左页怎么画

- `.away-scene` 盖住下面的空房间（WashRoom 仍在下面，出门／回来的上色转场继续由它负责）。
- 这次运行里亲眼看着她出门（`useLiveFlip` 的 `moved`）：空房间的出门转场先走，约 1.4 s 后外景在 0.7 s 内淡进来，总时长和原来的 `LEAVE_TOTAL_MS`（2.1 s）对齐；打开书时她本来就在外面，不重播“刚出门”。
- 四边用和左页其他整景图同样的椭圆＋上下渐隐蒙版贴进纸面；页角一张小纸签写去哪、几点回来（`voice/book.zh.json` 的 `note`，地点／时间来自快照）。
- 外景页不摆房间里的东西：隐藏墙钟（计时在迷你窗／右页）、台灯、门牌、信箱、窗台带回物；熄灯调色仍跟随根元素（时段／熄灯 token）。
- 历史照片：外景页在 `data-photo-scene` 根节点内，拍进历史照片的是外景本身；拍照排除规则不变。

## 迷你窗

`MiniCompanion` 在外出时用同一张外景，按 `align` 取景（她不在画面中央的素材用 `xMaxYMid`），时段调色仍只叠在 `ambient` 图片上；小窗的说明文字仍是她去哪了。自定义角色包优先包内素材。

## 验证（本轮实际运行）

- `pnpm` 原生命令仍受依赖前置校验阻塞，用等价入口：
  - `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json`：通过。
  - `eslint` 对本批改动文件：通过。
  - `node node_modules/vitest/vitest.mjs run --configLoader native --pool=threads tests/unit/away-art.test.ts tests/unit/character-art.test.ts`：2 文件 11 项通过（新增 `tests/unit/away-art.test.ts` 6 项：素材与清单存在、地点／时段映射、夜景 baked 不重复调色、海岸夜间回退、未知地点回退、所有外出假场景可解析）。
  - `node node_modules/electron-vite/bin/electron-vite.js build`：通过，五张外景进入 renderer 产物。
- 浏览器预览（真实渲染代码＋假数据，系统 Chrome 无头）：
  - `node scripts/ui-shot.mjs test-results/away-preview out-shore out-swing out-coast-night morning-idle night-lamp`：截图见 `test-results/away-preview/`；除已知 `/favicon.ico` 404 外无页面报错。
  - 出门转场：从 `morning-idle` 点开发栏“出门”，按 300/1200/1600/2200/3000/4200 ms 抓帧（`test-results/away-transition/`），确认空房间转场后外景才淡入，`data-moved="true"`，纸签为“去海边走走／回来时刻”。
  - 迷你窗：`?view=mini&scenario=out-swing|out-coast-night` 截图（`test-results/away-mini/`）确认外景与“她去秋千了／她去海边了”一致。
- **未运行**：本 checkout `node_modules/electron/dist` 缺失，所有 Electron 原生场景本轮没有跑；预览是渲染层假数据，不等于 Electron 窗口、透明、点穿或安装包验收。

## 仍待决定／仍缺的素材

- 下午素材里还有一批没有接进应用，属于“看效果再定”的候选：室内电影版五张（`indoor-11…15`，画面风格与现在 approved/ 的平面淡彩不同；要用就等于换整套左页画风，且电脑／睡眠／担心三姿势没有对应新图，会不一致）、`v6-05-first-notice`（新邮件）、`base-03-k13-quill`（礼物／羽毛笔）、`v6-16-dressed`（出门）、`v6-26/27`（日记页面）等。本轮只接了不改变既有画风的外景，其余等用户定。
- 张嘴／闭眼差分、`think` 表情、电脑／交流／外出专用夜景重光仍缺美术；嘴型目前只驱动声纹（`data-mouth` 已挂好，有差分图即可换图）。
- 海岸夜景是调色回退，不是重光；若要做，需要新画一张海岸夜景。

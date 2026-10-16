# 精修素材接入与 Claude 交接（2026-10-16）

## 后续五张替换（当前采用）

用户逐轮审图后明确授权：“非常好图片，替换现有素材并提交。”本轮保持十张正式素材的稳定文件名，更新五张：

| 运行素材 | 采用版本 | 变化 |
| --- | --- | --- |
| `facing-user_calm.png` | v5 hands-overlap calm | 自然转向用户，双手交叠轻放桌面 |
| `facing-user_smile.png` | v7 hands-overlap smile | 同一姿态的克制浅笑 |
| `facing-user_worried.png` | v8 interlaced worried | 轻微担心表情，手指松弛交叉，便于区分 |
| `desk-writing_calm.png` | v8 original-face day | 从原采用日图去掉书前小盆栽，沿用原脸型 |
| `desk-writing_night.png` | v8 original-face night | 从原采用夜图去掉小盆栽，沿用原脸型与夜灯 |

写字没有采用 v7 改视线／俯仰后的脸；大盆栽保留。v6 两张拢杯图继续作为本机候选，尚未选定。本轮不改状态选择、着色器、对白或主进程；书本、新手流程与迷你窗沿用同一素材入口。当前着色器从彩图实时提取铅笔底，已经不依赖旧线稿；下方首次接入记录保留其历史状态。

当前映射见 [`art/retouch-adopted.json`](../../art/retouch-adopted.json)，本轮原图来源、提示词、替换前后 SHA-256 见 [`art/retouch-round2-adopted.json`](../../art/retouch-round2-adopted.json)。只复制获批 PNG，没有再次生成或缩放。此前的候选 pending 标记不影响这五张的本次批准。

本轮检查：`pnpm build` 通过，十张构建产物的 SHA-256 与采用清单一致；`pnpm exec vitest run tests/unit/character-art.test.ts` 的 5 项通过。Chrome 假数据预览连续切换平静、浅笑、担心、写字夜景、清醒熄灯与睡眠夜灯，在 1600×1000、1280×720 两种窗口共 12 次检查中，实际素材、WebGL 绘制入口和光照模式正确，夜景无重复滤镜；迷你窗另核验五张资源映射与哈希。未发现页面脚本或 HTTP 加载错误。原图和书页截图已人工复核，迷你窗仍沿用原有固定裁切，并非本轮重新设计。详细结果见 [本轮预览记录](art-retouch-round2-review.json)，截图保留在精修 worktree 的 `.local-data/art-review-round2/`。

本轮只验收美术接入与浏览器假数据展示，不包含真实业务、Electron 透明／点穿行为或安装包；未重新打包。

## 首次整套接入记录

## 用户授权

本批来自用户专门开设的 NovelAI 精修对话。用户逐轮审图，最后明确：

> 收到，效果仍然很好，批准这一系列素材的使用，将“将NovelAI生成的图交给GPT-image进行精修”作为我们新的工作方法之一记进去，然后提交并修正我们现在的demo演示。以上行为由我批准

因此本次由 GPT 接入 Claude 原本负责的左页美术，是用户明确批准的跨线修改。只涉及左页素材、选择与光照、场景注释和相关文档；未改她的对白、提示词、共享接口或主进程生活逻辑。

## Claude 接续时需要知道的变化

- 正式入口是 `src/renderer/src/assets/character/taozi/approved/` 的十张 PNG。不要把旧 `close/`、`wide/` 图重新接回默认流程。旧图留作来源溯源，构建只引用新图。
- 四张 v1：看电脑、转头平静／浅笑／担心；写字采用本子朝向她的 v2。
- 睡眠与外出统一近景，电脑与笔记本均合上。睡眠夜间默认 v3 柔和夜灯，显式熄灯使用 v2 全暗。清醒的熄灯只是暂停，不代表进入睡眠。
- 外出画面是空房间，去向由 `locationId` 写到画内桌上纸条。外出／睡眠移除状态牌，避免错误挂牌。
- `book/characterArt.ts` 统一选择素材与光照模式。已有重光图使用 `baked-night`／`baked-dark`，不再叠加旧 `room-tint`／`room-lamp`；时钟和清醒状态牌单独降亮度。
- 新图与原线稿有轻微位置漂移，停止使用旧线稿，先让整景柔和淡入纸面。补匹配线稿时必须以新图为源，不能重新宣称整套逐像素对齐。下边缘另加渐隐，避免夜图的矩形裁切线。
- 尚未制作电脑／交流／外出专用夜景，仍使用原环境调色；清醒熄灯也仍为调色回退。此处尚不具备真实重光，不误报为全部昼夜差分完成。
- 工作方法已经写入 `AGENTS.md` 与 `docs/art-spec.md` §6.9。新增素材来源、输出哈希和全部历史提示词汇总在 `art/retouch-adopted.json`；工具不返回具体版本，不把调用记录说成已经确认是 2.5。

## 检查与复现

- `pnpm typecheck`：通过。
- 对本批 TS/TSX 文件运行 ESLint：通过。
- `pnpm exec vitest run tests/unit/character-art.test.ts tests/unit/ui-contract.test.ts`：2 个文件、7 项通过，覆盖素材存在、显式熄灯与睡眠的区别、外出优先和表情回退。
- `pnpm build`：通过，十张正式 PNG 均进入渲染产物。
- 浏览器预览按九个现有场景分别检查 1600×1000 与 1280×720：断言正式素材正确、图片已解码、保持 close、重光图无重复染色、外出与睡眠无状态牌、去向为海岸。实际报告见同目录 `art-retouch-review.json`。预览原有 `/favicon.ico` 缺失单独记录，不计作素材或脚本错误。
- 重跑截图：PowerShell 设置 `$env:LCA_SHOT_PORT='5417'`、`$env:LCA_SHOT_WAIT='4500'`、`$env:LCA_SHOT_SMALL='1'`，然后 `pnpm shot:ui .local-data/art-retouch-review`；不下载浏览器，不读取 providers。

本次检查为真实渲染代码下的假数据场景，没有临时替换 DOM。它验证美术与界面组合，不证明自主生活、实际邮箱或长期记忆业务通过。本批未重新生成 NSIS 安装包。使用源码预览查看新图；已安装的旧包不会自动更新。

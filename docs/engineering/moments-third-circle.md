# 书页生活瞬间与存档羽毛笔（2026-10-17 晚补接）

用户 2026-10-17 晚同意：先接“新邮件”和“礼物／羽毛笔”两个生活瞬间；同时指出书缝里那支存档羽毛笔表现较差，要求考虑优化。本文记录这一批（只改渲染层；没有动主进程事实、接口、存档和命令边界）。

## 新邮件：页角快照

- 素材：`src/renderer/src/assets/character/taozi/moments/first-notice.png`，来源视频冻结包 `selected/v6-05-first-notice.png`（她抬头注意到信的那一帧），只复制不重画；来源与 SHA-256 见 `moments/manifest.json`。
- 出现条件：邮箱能力 `ready` 且 `companion.mailboxUnseen > 0`。连不上或失败时**不出现**（失败不是“没有信”）；出门、外景页、历史旧页、新手流程都不显示。
- 样子：页角一张微微倾斜的小相片，照片下面是她的笔迹“有新邮件 · N 封”；`data-photo-omit`，拍历史照片时不把这张界面卡拍进去；点它不触发命令。
- 桌上的信封同时换成冻结包的邮件图标（`assets/ui/mail.png`，去掉透明留白后 708×460），不再用 CSS 叠画信封；数量仍在 title 里。

## 礼物卡：递笔插图

- 素材：`moments/quill-offer.png`，来源冻结包 `selected/base-03-k13-quill.png`（她把羽毛笔递过来的第 13 镜）。
- 礼物卡（`GiftCard`）改成左边一张方形照片、右边原文案；卡片语义和文字不变，其他礼物卡（`card-gift-made`、3D 礼物）不受影响。
- 仍如实说明这支笔是预制礼物，不宣称实时生成。

## 存档羽毛笔重画与入口提示

- `QuillArt` 重画：羽片加宽、羽枝和两个裂口更清楚，加金色笔箍、丝带蝴蝶结与两条飘带、笔尖高光与呼吸孔，笔尖桃色墨保留（美术规格 §2.5、§4 的语义不变）。
- `QuillDock`：书缝位置微调（60×274，top 512），旁边常驻一张小纸签“存档”，hover／focus 时纸签和笔一起轻轻抬起；笔有很轻的呼吸摆动（`prefers-reduced-motion` 关闭）。
- 导出逻辑、进行中／失败／结果文案、`backup.export` 命令、无障碍标签都没改；没收到笔之前仍只在设置页导出。

## 验证（本轮实际运行）

- `tsc --noEmit`（node／web 两个配置）通过；eslint 对本批文件通过（CSS 不在 lint 配置里）。
- Vitest：72 文件／506 项全过（新增 `tests/unit/moment-art.test.ts` 3 项：素材与清单哈希、邮件快照文案与场景、失败不是“没有信”）。
- `node node_modules/electron-vite/bin/electron-vite.js build` 通过（新素材进入 renderer 产物）。
- 浏览器预览：新增 `mail-new` 场景（`mailboxUnseen: 3`、mail ready），与 `break-delivery`（羽毛笔已送）一起截图（`test-results/moments/`）；除已知 `/favicon.ico` 404 外无页面报错。
- **未运行**：本 checkout 无 `node_modules/electron/dist`，Electron 原生场景（`smoke-*`）本轮没有跑；预览是假数据渲染层，不等于窗口、透明、点穿或安装包验收。

## 边界与待办

- 快照和礼物插图都是电影版画风，只作为“别在书页上的照片／卡片”出现，不替换 `approved/` 的姿势底图（用户 2026-10-17 晚决定：只有外景用电影版，不逐张凹姿势图）。
- 快照观感（大小、位置、是否只在本次新收到时短暂出现）待用户看过再定；现在是有未读邮件就常驻。
- 嘴型／眨眼差分、`think` 表情、电脑／交流／外出夜间重光仍需其他模型供图；需求单见[差分与夜景素材需求](art-deltas-request-20261017.md)。有了图，`data-mouth`（闭／半开／张开）和眨眼、夜景切换的接线点都已留好。

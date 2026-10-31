# 茶桌四位：站在小凳上打字

2026-10-31。团队远景改为全房间统一尺寸后，10-28 的四张茶桌坐姿（电脑放在腿上）只有放大到其他小桃子两倍多才够得到茶桌桌面，已停用。用户选定改画“站在小凳上，在桌面的电脑上打字”。诊断与新尺寸规则见[本轮回执](../../docs/research/team-room-scale-20261031.md)。

## 这次和上一轮的区别

- 电脑不画在人身上，单独画成道具，由程序放到房间的茶桌桌面上。上一轮提示词要求“电脑在身前、键盘高于大腿”，出图仍把电脑画在了腿上，模型不遵守这类数值。
- 人站在凳子上，凳子和人一起画；远侧两位的凳子会被桌子挡住，两端两位的凳子露在外面。
- 尺寸来自房间实测：按当前尺寸规则，茶桌桌面约在小桃子站高的 3/4 处。凳面在她站高的 1/3、双手在腰的高度，手就正好落在桌面上。程序会按头部大小统一缩放，误差在一成以内可以在接入时微调。

## 建议用法

在 ChatGPT（图像）里出图，附上已采用的 v2 素材作参考，保持与现有 12 张一致的线条和配色：

- `art/retouch/2026-10-28-team-complete/work-sheet.png`（工作六姿态原稿，本机）
- `art/retouch/2026-10-28-team-table-imagegen-v2/generated-sheet.png`（凳子的样子，本机）

如果画风跑偏，再试 Gemini。请保存工具给出的原始下载文件，不用聊天里转存的压缩图。

## 提示词（可直接复制）

```text
Create ONE production sprite sheet for the SAME chibi girl as the attached approved sprites. Keep her exact identity and drawing style: peach bob with lavender tips, grey amber eyes, navy hair ribbon on HER anatomical LEFT, ivory cardigan with round white collar, lavender skirt, white socks, dark grey shoes, compact about 2.2-head proportions, mitten hands, bolder outer outline. This is a production expansion, not a redesign.

STRICT grid: 3 equal columns by 2 equal rows on a pure opaque WHITE background, wide completely empty gutters, generous padding around every object. Every figure, stool and laptop must be complete inside its own cell. No text, labels, numbers, borders, shadows, floor plane, scenery, table or other furniture. Mild elevated camera, the same as the attached sprites. All four girls have the same head size; both laptops are drawn at the same scale as the girls.

The four girls each STAND with both shoes on top of a small backless pale wooden stool (same style as the attached stool reference). The stool top is at one THIRD of her own standing height. She is typing: both forearms held forward and level at her waist height, relaxed mitten hands, eyes looking down at where a laptop screen would be. Do NOT draw any laptop, keyboard or table with the girls; the laptops are separate objects in their own cells.

Cells in strict reading order:
1 TOP LEFT: girl on stool, facing the viewer in three-quarter view turned toward IMAGE RIGHT. Ribbon on her left, mostly on the far side.
2 TOP MIDDLE: girl on stool, facing the viewer in three-quarter view turned toward IMAGE LEFT. Ribbon clearly visible on her left side.
3 TOP RIGHT: an open pink laptop seen from BEHIND its screen, slightly from above: we see the back of the lid with a small round logo and only a thin edge of the keyboard base. Its lid height is about 0.6 of the girls' head height.
4 BOTTOM LEFT: girl on stool, pure side view facing IMAGE RIGHT, forearms reaching forward to the right. Ribbon is on the far side: at most a small tail.
5 BOTTOM MIDDLE: girl on stool, pure side view facing IMAGE LEFT, forearms reaching forward to the left. Ribbon fully visible.
6 BOTTOM RIGHT: the same open pink laptop seen from the SIDE, slightly from above: keyboard base toward IMAGE LEFT, hinge and screen at IMAGE RIGHT, screen leaning back slightly, its display facing image left.

Never mirror a girl to change her direction; draw each pose separately. Keep shoes, stool legs and hands complete. Each girl must stay recognizable when shrunk to 100 pixels high. Output a single clean high-resolution sprite sheet.
```

## 审图关口

1. 身份：脸、发色、眼睛、衣服与已采用的 v2 小桃子一致，没有变成另一种画风。
2. 丝带：1 号在远侧（最多露一点），2 号可见，4 号最多露尾巴，5 号完整可见。不能靠镜像改朝向。
3. 比例：四位头一样大；凳面约在站高 1/3；双手在腰的高度、前伸。
4. 四位身上没有电脑、键盘或桌子；两台电脑各在自己的格子里，和人同一比例。
5. 白底、格子之间留空，鞋、凳腿、手完整，没有文字。

## 切图与接入

原图存进新的 `art/retouch/2026-10-31-team-stool-standing/`，不覆盖已采用素材。切图（末尾为 2 行 3 列）：

```powershell
pnpm exec electron art/tools/cut-chibi-sprites.cjs <sheet> art/retouch/2026-10-31-team-stool-standing 'stool-back-left,stool-back-right,laptop-back,stool-end-left,stool-end-right,laptop-side' 2 3
```

接入时：

1. 四张人物改名 `mini-v2-stool-*.png`，写进 `team/manifest.json`。
2. 运行 `node art/tools/measure-team-sprites.mjs` 更新尺寸表。电脑没有头发，测量工具要先补“道具只量大小和底边”。
3. 在 `teamArt.ts` 把茶桌打字换成这四张，凳子画在图里时不再垫高。
4. 新增电脑图层：远侧放背面电脑挡住双手，两端放侧面电脑（右端用镜像，电脑可以镜像，人不行）。
5. 截图核对：手落在桌面电脑上、凳脚落地、远侧的凳子被桌子挡住；维护者确认后再采用。

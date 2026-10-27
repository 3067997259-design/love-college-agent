# 桃子设定图 v2 · 给 Gemini 的说明与提示词

2026-10-27 起草。用途：用户把本文和附图交给 Gemini，请它说明该怎么出这张图，或直接出图。现行设定图是赛中的 [design-sheet-v1](../design-sheet/design-sheet-v1.png)，只有三视图、出门服和四个头像表情，缺少 Q 版、配色、细节特写和表情范围。下面第 1 节可以整段粘贴。

## 1. 发给 Gemini 的说明（中文）

> 我在做一个桌面陪伴应用，内置角色叫“桃子”。附图 1 是现行角色设定图，附图 2 是应用里已采用的画面（画风基准），附图 3、4 是用 NovelAI 试出的 Q 版小人，效果一般。
>
> 我需要一张更新的**角色设定图 v2**，作为后续所有出图（NovelAI 底稿 + 局部精修）的身份基准。其中最重要的是 **Q 版小人的设计**：应用里会有好几个 Q 版桃子在房间里帮忙干活，显示时只有 60–90 像素高，要一眼认出是她。
>
> 请先告诉我：
> 1. 日系动画 / 游戏一般怎么从正常比例角色设计 Q 版：头身比、哪些特征保留并放大、哪些简化掉、五官和手脚怎么处理、线条粗细怎么调。
> 2. 按这个思路，桃子的 Q 版应该保留什么、简化什么。附图 3、4 的问题在哪里。
> 3. 一张专业的角色设定图通常包含哪些部分、怎么排版。
>
> 然后按第 2 节的内容出图（或给出你会用的提示词）。画风必须和附图 2 一致：彩色细线稿、平涂、淡彩，阴影只有一层带薰衣草色的硬边阴影，光从左上来。不要写实、不要厚涂、不要高饱和。

## 2. 设定图 v2 应包含的内容

**固定身份（所有部分都要一致）**

- 成年大学生，身材纤细，正常比例约 6.5–7 头身。
- 发型：齐下巴的短波波头，发尾微微向内收；发色淡桃粉，带一点暖桃色（约 `#FCD7CB`）。没有呆毛。
- 标志物：一根细的深藏青丝带（约 `#2E3350`），系在**她自己的左侧**头发上，打一个小结，两条短尾像书签带一样直直垂下。正面看在画面右侧，背面看在画面左侧，右侧视图里看不到。
- 眼睛：偏灰的淡琥珀色，不是棕色。表情克制、平静。
- 居家服：白衬衫配小圆领，米白针织开衫（袖口、下摆有罗纹），淡薰衣草色长裙到小腿中段，白袜，浅灰室内拖鞋。
- 出门服：深藏青短斗篷配一枚小金扣，白衬衫圆领，同一条长裙，白袜，深棕乐福鞋。

**版面（横版，建议 16:9 或 3:2）**

1. 正常比例三视图（正 / 侧 / 背），居家服；旁边小一号的出门服正面。
2. Q 版设定：同一套居家服的 Q 版正 / 侧 / 背三视图，约 2.5 头身；旁边放一个与正常比例并排的身高对照。
3. Q 版表情与动作小格（每格一个小人，白底）：平静、微笑、专注打字、翻大书、抱一摞纸、举起小纸条等你确认、递出完成的纸、对着纸困惑（一滴小汗）、捧小杯子休息。
4. 正常比例头像表情：平静、浅笑、思考、担心、专注（看屏幕）、惊讶、困、温柔地笑，共 8 个。
5. 细节特写：丝带系法与位置（标明“她的左侧”）、发尾内收的形状、眼睛、开衫领口与纽扣、拖鞋。
6. 配色条：发色（亮部 / 阴影）、丝带、眼睛、开衫、长裙、肤色、薰衣草阴影色，每块下方留空写色值。

不要：文字说明以外的标志、水印；第二个角色；改动发型、发色、丝带位置或服装；棕色眼睛；粗黑描边；写实或 3D 质感。

## 3. 英文出图提示词草稿

整张设定图一次出往往细节不足，可以按版面分块出，再拼合。

**整体（版面 1、4、5、6）**

```text
Professional anime character design sheet on a plain white background, clean layout with labeled sections. Art style: colored thin lineart, flat pastel colors, a single tone of hard-edged lavender shadow, light from the upper left, soft and calm Japanese slice-of-life anime look, no realism, no heavy rendering.
Character: a slender young adult woman, college student, about 7 heads tall. Chin-length bob of pale peach-pink hair with the ends curling slightly inward. A thin dark navy ribbon tied on HER LEFT side of the head, a small knot with two short tails hanging straight down like a bookmark ribbon. Muted greyish light-amber eyes, calm restrained expression.
Indoor outfit: white blouse with a small rounded collar, cream knit cardigan with ribbed cuffs and hem, pale lavender long skirt reaching mid-calf, white socks, light grey indoor slippers.
Sections: full-body turnaround (front, side, back) in the indoor outfit; a smaller front view in the outing outfit (dark navy short capelet with a small gold clasp, same blouse and skirt, dark brown loafers); a row of 8 head-and-shoulders expressions (calm, soft smile, thinking, worried, focused on a screen, surprised, sleepy, gentle smile); close-up details of the ribbon knot and its position, the inward-curling hair ends, the eyes, the cardigan collar and buttons, the slippers; a color palette strip with swatches for hair, hair shadow, ribbon, eyes, cardigan, skirt, skin, and the lavender shadow.
```

**Q 版（版面 2、3）**

```text
Chibi (super-deformed) version of the same character for a cute helper sprite set, plain white background, same art style: colored thin lineart, flat pastel colors, one tone of lavender shadow, light from the upper left.
About 2.5 heads tall. Keep and enlarge the identifiers: the peach-pink bob silhouette with inward-curling ends, the dark navy ribbon on her left side with two short hanging tails, greyish amber eyes, cream cardigan, pale lavender long skirt, white socks, grey slippers. Simplify: large simple hair shapes, few strands, big soft eyes with a small highlight, tiny mouth, mitten-like hands, short legs, no fabric clutter.
Show: front, side and back turnaround; a height comparison standing next to the normal-proportion character; and small poses: calm, smiling, typing on a tiny laptop, hugging a big open book, carrying a stack of papers, holding up a small paper slip while looking up, handing over a finished sheet, puzzled over a page with one small sweat drop, resting with a tiny mug.
Must read clearly when shrunk to 80 pixels tall.
```

## 4. 附图

| 顺序 | 文件 | 作用 |
| --- | --- | --- |
| 1 | [design-sheet-v1.png](../design-sheet/design-sheet-v1.png) | 现行设定图，身份基准 |
| 2 | [desk-computer_calm.png](../../src/renderer/src/assets/character/taozi/approved/desk-computer_calm.png) | 已采用画面，画风基准 |
| 3 | `art/retouch/2026-10-27-mini-taozi-sheet/mini-sheet-271829-nai.png` | NovelAI Q 版试稿（圆短），效果一般 |
| 4 | `art/retouch/2026-10-27-mini-taozi-sheet/mini-sheet-271831-nai.png` | NovelAI Q 版试稿（稍修长），效果一般 |

附图 3、4 在本机审图目录里，不随仓库分发。

## 5. 拿回来之后

Gemini 的回答和出图作为设计参考，不直接作为应用素材。定稿的设定图 v2 存入 `art/design-sheet/`，再按 [团队画面方案](2026-10-27-team-room.md) 更新身份与 Q 版提示词；运行时素材仍走候选、审图、采用的流程。

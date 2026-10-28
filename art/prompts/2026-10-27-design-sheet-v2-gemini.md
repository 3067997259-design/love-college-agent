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

## 6. 第二轮：修正设定图、量产精灵表、试画房间

第一轮结果与核对见本机 `art/retouch/2026-10-27-gemini-sheets/README.md`。规则：**生成图里不要任何文字**，标题、标签和色值由我们自己排，避免再出现抄错页眉、标错表情的问题。每张图从 Gemini 下载原图（不要聊天里转存的压缩图）。

### 6.1 Q 版量产精灵表（附上一轮的 Q 版表）

> 参考附图（你上一轮画的桃子 Q 版设定与动作表）。人物造型、约 2.2 头身的比例、线条粗细、配色和画风完全保持不变，重新出一张用于切图的精灵表：
> 1. 九个动作全部画成全身：待机、开心地笑、坐在地上用小电脑打字、抱着打开的大书读、抱着一摞纸走路、举起一张小纸条抬头等人确认、递出一页纸、对着纸困惑（头边一滴小汗）、坐着双手捧小杯子休息。
> 2. 3×3 等距排列，所有人物用同一缩放比例，脚底落在各自格子的同一条底线上；格子之间留足空白，人物和道具互不重叠，不画格线和边框。
> 3. 纯白背景，不要任何文字、编号或标题，不要地面和投影。
> 4. 丝带始终系在她自己的左侧：正面时在画面右侧，背面时在画面左侧；身体朝画面左边时，镜头看到的是她的左侧，丝带要画出来；身体朝画面右边时，丝带在远离镜头的一侧，最多露出一点尾巴。

### 6.2 设定图 v2 修正（附上一轮的设定图 v2）

> 参考附图（你上一轮画的桃子角色设定图 v2）。人物、构图、配色和画风保持不变，只改下面几处：
> 1. 去掉所有文字：页眉、表情名称、特写框标题、色卡说明都不要，位置留白。
> 2. 背面全身图补上丝带：从背后看，丝带在画面左侧，露出小结和垂下的两条短尾。
> 3. 色卡第二格（头发阴影）改浅，接近 #E8C2D1 的浅粉紫，其余色块不变。
> 4. 表情行在现有 4 个右边或下方再加 4 个，用同样的肩部裁切：平静（睁眼、嘴闭着）、浅笑（睁眼）、思考（视线看向一侧、手指点下巴）、担心（眉尾下垂）。

拿回来后，表情名称由我们按实际内容标注：原 “Surprised” 那格实际是睁眼的温柔浅笑。

### 6.3 试画团队房间（附 3 张图）

附图：[三维布局底稿](../retouch/2026-10-26-team-room-v1/room-geometry-v2.png)（本机文件）、[已采用画面](../../src/renderer/src/assets/character/taozi/approved/desk-computer_calm.png)、修正后的设定图 v2。

> 附图 1 是房间的三维布局底稿，机位、透视、家具位置都已经定好；附图 2 是应用里已采用的画面，作为画风基准；附图 3 是角色设定图。
> 请严格按附图 1 的机位和家具位置画这个房间：地板线、墙角、窗框、书架、书桌、椅子、前景矮桌和地毯的位置与透视都不要改。画风照附图 2：彩色细线稿、平涂、淡彩，一层薰衣草色硬边阴影，光从左上方来，窗外蓝天白云。
> 人物：附图 3 的桃子，穿居家服（米白开衫、白圆领、淡薰衣草长裙、白袜、浅灰拖鞋），坐在书桌右侧长边的椅子上，身体朝画面左侧，双手在粉色笔记本电脑上打字，膝盖在桌下，双脚放在地上。底稿里的人偶只表示她的位置和姿势。
> 前景矮桌和地毯上保持空着，之后会放 Q 版小人。画面里不要文字，不要第二个人。

这张如果透视和人物都过关，就替代原方案里的 NovelAI 图生图（A 层）；不过关再回到 NovelAI 路线。

### 6.4 房间局部修正（附第二轮房间图 + 已采用画面）

附图：第二轮房间原图、[已采用画面](../../src/renderer/src/assets/character/taozi/approved/desk-computer_calm.png)。

> 编辑附图 1（你画的房间）。构图、透视、家具位置、光影和人物姿势全部保持不变，只改这几处：
> 1. 头发颜色：改成附图 2 里她那种偏粉的淡桃色，亮部约 #F1D0C6，发梢阴影是浅粉紫（约 #E8C2D1），不要偏橙的杏色。发型和丝带不变。
> 2. 墙面：两面墙改成附图 2 里窗下那种淡薄荷绿（约 #CDE9E0），窗框也用淡薄荷色；天花板保持暖白。
> 3. 去掉她下巴下方那一小撮多余的线。
> 画面里不要文字。

### 6.5 设定图侧视图（附第二轮设定图）

> **不需要了（10-28 更正）**：第一、二轮设定图的侧视图其实都朝画面左边、丝带在近侧，本来就是对的。是我把朝向看反了。

> 编辑附图（你画的设定图）。只改第二个全身图（侧视图）：让她转成身体朝画面左边的侧面。她的丝带系在自己的左侧，朝左时镜头看到的正是她的左侧，所以丝带、小结和两条短尾要清楚地画出来。其余所有人物、特写和表情保持不变，不要加文字。

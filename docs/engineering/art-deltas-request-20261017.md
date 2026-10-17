# 需要其他模型画的差分与夜景（2026-10-17 晚）

**采用更新（2026-10-17 晚）：** 下列 19 张已全部生成并自审，原采用图未被覆盖；用户确认“这几张我都特别喜欢，差分刻画的很好”，按整批采用。入口见 [审图页](../../art/retouch/2026-10-18-face-deltas/review.html)、[交付记录](art-deltas-delivery-20261017.md) 与[接入记录](face-deltas-adoption-20261017.md)。

给负责画图的其他模型：这些是**同一张已采用底图的局部变体**，不是重新构图。画好交给我接线（眨眼、说话嘴型、抬头、夜间重光）。用户 2026-10-17 晚已同意“只做差分，不逐张凹新姿势图”。

## 通用要求（每批都适用）

- 底图只用 `src/renderer/src/assets/character/taozi/approved/` 里对应的那张 PNG（1254×1254）；外景用 `src/renderer/src/assets/character/taozi/away/coast-day.png`（1517×1037）。**不要**用参考 PV 截图或其它旧图当输入。
- 输出画布、构图、机位、画风必须与底图一致：彩色细线、淡彩、单一薰衣草阴影、左上光源；不改脸型、发型、丝带所在侧、领口、手、书桌、道具和背景。
- 一次只改一处：闭眼就只改眼睛；张嘴就只改嘴；抬头就只改眼睛朝向和极轻的头部角度；夜景只改光。
- 输出 PNG（sRGB，不缩放、不裁切、不加文字/水印），文件名按下表；不要覆盖 `approved/` 原文件。
- 交付目录：`art/retouch/2026-10-18-face-deltas/`，每张附一条记录（底图路径、提示词、seed、工具与版本（工具不报版本就写未报）、输出 SHA-256、仅改动的区域）；可选 `review.html` 方便逐张审。
- 我这边会用逐像素 diff 验收：眨眼／嘴型／抬头除指定面部区域外应基本不变；夜景允许整帧变光，但姿势、道具、构图不能变。改动溢出到头发、丝带、手或背景的，退回重做。
- 先审图再接线：每张由用户看过再采用。

## P1：眨眼（最影响“她一直在”的观感，优先画）

| 文件名 | 底图 | 只改什么 |
| --- | --- | --- |
| `facing-user_calm__blink.png` | `approved/facing-user_calm.png` | 双眼自然闭合（上眼睑落下、睫毛可见），不改成睡觉的弯线，眉眼其余不动 |
| `facing-user_smile__blink.png` | `approved/facing-user_smile.png` | 同上（浅笑保持） |
| `facing-user_worried__blink.png` | `approved/facing-user_worried.png` | 同上（轻微担心保持） |
| `desk-writing_calm__blink.png` | `approved/desk-writing_calm.png` | 低头写字姿势的双眼闭合，视线区域小、别改手和笔 |
| `desk-computer_calm__blink.png` | `approved/desk-computer_calm.png` | 看电脑姿势的双眼闭合，手和电脑不动 |

用途：每 2–6 秒随机闭眼约 0.15 秒（体验设计 §3）。这五张能覆盖书本所有日常姿势。

## P2：不依赖语音、直接能用的（次优先）

| 文件名 | 底图 | 只改什么 |
| --- | --- | --- |
| `desk-writing_calm__look-up.png` | `approved/desk-writing_calm.png` | 头几乎不动，眼睛从纸面抬起来看观众（窗口获得焦点时“抬头看你一眼”，体验设计 §3） |
| `desk-computer_calm__night.png` | `approved/desk-computer_calm.png` | 同机位夜景：左侧台灯暖光、窗外夜色；她、电脑、道具、构图不变 |
| `facing-user_calm__night.png` | `approved/facing-user_calm.png` | 同上 |
| `facing-user_smile__night.png` | `approved/facing-user_smile.png` | 同上（浅笑保持） |
| `facing-user_worried__night.png` | `approved/facing-user_worried.png` | 同上（担心保持） |
| `empty__night.png` | `approved/empty.png` | 空房间夜景，台灯关着、窗外夜色；桌面道具位置不变 |

用途：解决现在电脑／交流／空房间在夜里走灰紫调色、发色发灰和“窗外白天”穿帮；有了图就按 `daypart` 切 baked 夜景。

## P3：等 TTS／可选（有余力再画）

| 文件名 | 底图 | 只改什么 |
| --- | --- | --- |
| `facing-user_calm__mouth-half.png` | `approved/facing-user_calm.png` | 嘴微张，像说话中间（不夸张、不露齿或只露一点） |
| `facing-user_calm__mouth-open.png` | `approved/facing-user_calm.png` | 嘴张开一个元音口型，口腔/舌尖自然，不要大笑 |
| `facing-user_smile__mouth-half.png` / `__mouth-open.png` | `approved/facing-user_smile.png` | 同上，保留浅笑 |
| `facing-user_worried__mouth-half.png` / `__mouth-open.png` | `approved/facing-user_worried.png` | 同上，保留轻微担心 |
| `facing-user_think.png` | `approved/facing-user_calm.png` | 第 4 种表情：视线微垂/看向侧上，眉轻聚，克制不夸张；其余不变 |
| `coast-day__night.png` | `away/coast-day.png`（1517×1037） | 同一构图的海岸夜景（月光/夜色），她、伞、脚印、海面位置不变 |

用途：嘴型三档（闭／半开／张开）接 `data-mouth`；`think` 补第 4 表情；海岸夜景把外景页的调色回退换成真重光。TTS 服务确定前，嘴型可以晚一步。

## 最小可用批次

如果时间紧，先交 **P1 五张眨眼**，我就能把“她一直在”的眨眼接上；再交 **P2 的抬头和五张夜景**，白天的书和夜里就不一样了。其余按 P3 慢慢补。

## 交给我之后

我会在渲染层接线：眨眼定时、`data-mouth` 三档换图、窗口 focus 抬头、按 `daypart` 切 baked 夜景；每张都先跑浏览器预览截图再合并，并在记录里写清哪些是真实图、哪些仍是回退。

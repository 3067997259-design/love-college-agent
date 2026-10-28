# 茶桌凳子坐姿：imagegen 重画与试摆

2026-10-28，维护者在看过悬空的四坐姿合成后，明确授权使用 image 重画并测试。使用内置 imagegen，共两次编辑调用；没有使用 API CLI 或另外的生成服务。

第一轮保留角色身份、衣服与四方向，补齐凳子和弯腿坐姿。透明输出出现边缘杂色，行间也跨过了等分线，原稿留在 `art/retouch/2026-10-28-team-table-imagegen-v1/`。第二轮保持姿势、清理到白底，原图、四张切图和预览保存在 `art/retouch/2026-10-28-team-table-imagegen-v2/`。维护者随后认可效果并要求补齐其余团队素材，本版四张已接入 `mini-v2-table-*`；后续十二张见[完整素材记录](2026-10-28-team-complete-imagegen.md)。

第二轮原图 SHA256：`8D95792879719E0901EF4EBEB809CED22989FDF317CD53F15F6320882C1C3195`。按真实行间隔 y=650 分切 1254×1254 图，白底沿边界去除，凳子横档内封闭的白底区域另用已核对种子去除；白袜、衣领保留。原始生成文件不覆盖。

书页试摆重新校准四个座位的尺度与落点，按新位置调整家具前后关系，并将袖口 / 手 / 电脑的原图裁切层显示在桌面上方。`preview.mjs --capture` 通过新旧对照、四位点击、夜间和窄窗口检查，回执为 `review/report.json`；截图 `review/stools.png`、`stools-night.png`、`stools-narrow.png`。修正前遮挡截图保留用于对照。

左右两位有可见的凳子支撑；新稿比原精灵线条更干净、颜色略亮。大小桃子画风统一由用户明确后置。正式素材与 manifest 已用版本化文件接入，旧版保留；[本轮回执](../../docs/research/team-room-art-complete-20261028.md)区分布局、合成团队流程和未运行的真实服务 / 安装验收。

## 第一轮实际提示词

```text
Use case: identity-preserve edit. Deliver ONE production sprite sheet, 2 rows by 2 columns, with real transparent background, generous transparent gutters, no text, no grid, no floor plane.
Image 1 is the edit target: retain the exact four chibi girls' identity, face design, peach bob hair with lavender tips, grey amber eyes, ivory cardigan and rounded white collar, lavender skirt, white socks, dark grey shoes, navy hair ribbon, pink laptop, clean warm linework and restrained pastel shading. Image 2 is ONLY the already approved room/camera reference: match its mildly elevated three-quarter view and the low tea table at bottom left. Do not redraw that room or include its furniture/background in the output.
Correct the four poses so these characters can actually sit at that tea table. Every character must sit with her pelvis visibly resting on a small backless pale wooden stool. Draw the entire stool including sturdy legs ending on the same ground plane as the character's shoes. Bend the knees naturally, lower legs downward, feet relaxed; no straight outstretched floor-sitting legs, no levitating pelvis, no standing, no long adult legs. Keep cute compact proportions and matching scale across all four cells.
CRITICAL ergonomic change: hands and forearms reach forward to type at table height. The laptop is IN FRONT of the torso, clearly separated from the lap and knees by transparent space. Its flat keyboard/base is higher than the thighs by about one-third of a head height. It will be supported by the existing tea table in software. DO NOT draw a table or board under it; do not place it on her lap. Imagining tabletop height T above the floor, stool seat height is approximately 0.60T; wrists at T; shoulders naturally above the wrists. Do not merely add a stool beneath the old lap-laptop pose.
Composition: top left seated facing camera and slightly to image right; top right facing camera and slightly to image left; bottom left side view facing image right; bottom right side view facing image left. All from the room's slightly elevated camera, visibly looking down toward laptops. Render every figure complete, with computer, hands, skirt, lower legs, shoes and stool all intact inside its own cell. Never crop at future table occlusion.
Hair ribbon is ALWAYS on HER anatomical left: top-front views at image right as appropriate; on the right-facing bottom-left pose it is on the far side, hidden or only a tiny tail; on the left-facing bottom-right pose it is fully visible. Do not mirror sprites to change direction. No added accessories, brand symbols, dramatic lighting, drop shadows, white backdrop, checkerboard pixels or room furniture. Preserve the established character art style rather than redesigning her.
```

## 第二轮实际提示词

```text
Use case: precise-object-edit. Clean up the provided four-pose sprite sheet for production extraction. Preserve these four stool-seated characters exactly: faces, proportions, line art, clothing, hair ribbons, stools, hands, pink laptops and facing directions. Do not redesign the characters.
Change the transparent backdrop to an absolutely pure opaque white background. Remove all stray red, yellow, magenta, grey and white fringe/speckle artifacts outside the actual dark character/stool/laptop outlines. Restore clean smooth antialiased edges against white; no colored glow. Preserve intentional ivory clothing, white socks and the original warm outlines.
Keep a strict 2 by 2 regular grid. Give every complete character, laptop, shoes and full stool legs generous white padding inside its own quadrant, with a wide completely empty horizontal gutter at the exact image midpoint. No object may touch or cross a quadrant boundary. Four matching-scale sprites, centered individually in their cells, all feet and stool bottoms intact. No text, borders, shadows, background scenery, or table. Output one square opaque white sprite sheet.
```

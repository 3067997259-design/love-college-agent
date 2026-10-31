# 团队房间第二版工作与状态素材

用户在凳子预览后要求继续补齐全部团队素材并接入子代理状态；大小桃子画风统一后置。本批采用内置 imagegen，以已确认的小桃子形象和凳子版为参照，不改变大房间。

原稿与裁切位于 `art/retouch/2026-10-28-team-complete/`，原图只留本地。使用现有 `art/tools/cut-chibi-sprites.cjs` 按 2 行 3 列裁切、边缘白底连通移除；不改角色像素。运行资源采用版本名 `mini-v2-*`，保留旧版。

## 工作六姿态

```text
Create ONE coherent six-pose game sprite sheet based on the attached approved chibi identity. 3 columns by 2 rows on a perfectly pure opaque white background. Equal cells, wide empty gutters, generous padding at all outer and cell edges. Each whole body must fit inside its cell. No text, labels, panels, symbols, shadows, scene, furniture, or computers.
Keep the EXACT chibi identity and style of the attached girls: peach bob with lavender tips, grey amber eyes, navy ribbon on HER anatomical left, ivory cardigan and round white collar, lavender skirt, white socks, dark grey shoes. Compact roughly 2.2-head proportions, consistent head size and body scale across all six cells. Camera slightly above, appropriate for the same dollhouse room. We are adding poses, NOT redesigning her and NOT harmonizing with a different room art style.
Six different poses in strict reading order:
1 TOP LEFT: standing three-quarter facing IMAGE LEFT, reaching one hand up to take a small brown book from an unseen bookshelf, other hand ready below. No bookshelf drawn. Navy ribbon on the visible left side of her head. Clear grounded feet.
2 TOP MIDDLE: standing mostly BACK toward viewer, head slightly turned to IMAGE LEFT, looking down into an open brown book held in both hands; show back of hair and cardigan; ribbon on IMAGE LEFT (her anatomical left). No furniture.
3 TOP RIGHT: standing side/three-quarter facing IMAGE RIGHT, politely extending a white paper forward with both hands to an unseen colleague. Ribbon is on the far side, mostly hidden, never mirror the ribbon to the near side.
4 BOTTOM LEFT: standing three-quarter facing IMAGE LEFT, reading a small white note in both hands, attentive expression; visible left-side navy ribbon. Distinguish this from delivering paper.
5 BOTTOM MIDDLE: walking into the room toward IMAGE RIGHT, one modest forward step, hands relaxed, alert welcoming expression; ribbon mostly hidden on far side. Not running, not jumping.
6 BOTTOM RIGHT: standing front facing viewer, arms resting by her sides, neutral attentive expression, feet planted. No paper, no book, no props. Ribbon on image right.
No duplicates, no mirroring, no changed clothes, no additional limbs. Each silhouette must read clearly when shrunk to 100 pixels high. Keep all shoes and hands complete. Output a single clean high-resolution sprite sheet.
```

## 状态六姿态

```text
Create ONE six-pose status sprite sheet for the SAME chibi girl as the attached sheet, preserving exact face, peach/lavender bob, grey amber eyes, navy ribbon on HER anatomical LEFT, ivory cardigan and white round collar, lavender skirt, white socks and grey shoes. Same clean pastel chibi drawing style and compact proportions. This is a matching production expansion, not a redesign.
STRICT grid: 3 equal columns by 2 equal rows on pure opaque WHITE, wide completely empty gutters at both vertical thirds and the horizontal midpoint, padding around each complete figure, no cropped hands or shoes. Same head size throughout. Mild elevated camera for a dollhouse room, no scenery, furniture, labels, typography, watermarks or UI.
Six expressive status poses in exact reading order:
1 TOP LEFT, THINKING: front three-quarter, one hand under chin, other arm folded supporting it, head slightly tilted, thoughtful puzzled face with ONE small blue sweat drop near her temple. No paper, no book, no computer. Do not look triumphant or alarmed.
2 TOP MIDDLE, WAITING FOR USER: directly facing viewer, politely holding a plain white sheet upright toward the viewer at chest level with both hands, patient attentive eyes. Feet planted, no walking.
3 TOP RIGHT, FAILED / BLOCKED RESULT: front three-quarter, both EMPTY hands visibly spread outward palms up, shoulders slightly raised, apologetic concerned face. Clear wide shrug silhouette. No sweat drop, paper, book, computer, checkmark or text. Must remain visually distinct from pose 1 even without color.
4 BOTTOM LEFT, COMPLETED: facing viewer, gentle satisfied smile, extending a small plain white finished document toward viewer with both hands, slight forward inclination. Distinct from the upright waiting paper; present it forward as a result. No trophy, no large celebration.
5 BOTTOM MIDDLE, RESTING / IDLE: seated comfortably cross-legged on the floor, hands resting on knees, relaxed neutral expression, no props, no stool. Complete body and feet. Not the same pose as finishing work.
6 BOTTOM RIGHT, STOP REQUEST IN PROGRESS: standing facing viewer, one relaxed open palm raised at waist/chest height as a pause gesture, other arm down, calm neutral expression. No smile of accomplishment, no paperwork, no sweat drop. It is a pause gesture, not a completed result.
Keep the navy hair bow at image right in frontal views; never mirror identity. Preserve the same clothes and eye design in all six. Each silhouette must read at 100 pixels high. Output one square sprite sheet.
```

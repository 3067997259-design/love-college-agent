# 角色形象参考

之后所有角色出图（Gemini 构图、NovelAI 放大、GPT-image 局部修改）都以这里的设定图为身份基准。

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `design-sheet-v2.webp` | **当前基准**，2026-10-28 用户采用 | 4115×3571。居家服三视图与出门服、细节特写、8 个表情、侧脸三角度、实测配色。 |
| `design-sheet-v1.png` | 历史 | 2026-10-16 赛中 NovelAI 出图；全身像的脸与 v2 不同，不再作为基准。 |

## v2 的来源

- 构图与人物：Gemini 内置生图（用户称 nano banana），工具未回报具体模型版本。全身像的脸经第二次请求按表情差分重画。
- 清晰度：`art/tools/novelai-upscale.mjs`（NovelAI 放大，`nai-diffusion-5-curated`）。全身块两次 2 倍（声明模糊 0.5、0），其余三块一次 2 倍（0.5）。每次放大后都对照原图核对脸没有变。
- 文字、表情名称和色卡由我们排版：`art/tools/assemble-design-sheet-v2.cjs`，字体为应用自带的霞鹜文楷屏幕版。色值从已采用的书桌近景实测（长裙取自设定图本身）。
- 仓库里是 WebP（质量 0.95，2.4 MB，与无损原图平均差 0.86/255）；无损 PNG 原图在本机 `art/retouch/2026-10-28-design-sheet-v2/design-sheet-v2-final.png`（20 MB，不随仓库分发）。

## 用的时候注意

- 丝带系在她自己的左侧：正面在画面右侧，背面在画面左侧，身体朝画面左边时露出，朝右时在远侧。
- 表情第 8 个（担心）半身在 Gemini 原图里被右缘裁掉一截。
- 制作过程与核对记录在本机 `art/retouch/2026-10-27-gemini-sheets/`、`2026-10-28-design-sheet-v2/`、`2026-10-28-face-fix/`、`2026-10-28-nai-upscale/`。

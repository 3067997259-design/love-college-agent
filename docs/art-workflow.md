# 美术制作入口：NovelAI 底稿与 GPT-image 精修

2026-10-26 重新核对本地材料。用户确认后续角色与场景素材继续采用比赛时的 **NovelAI 底稿 → GPT-image 精修 → 集中审图 → 采用并接入** 流程。首张房间候选已完成真实调用，仍待修订与采用。

## 材料保存在哪里

| 材料 | 当前入口 | 用法与边界 |
| --- | --- | --- |
| 原始生成参数与词 | [art/gen-log.jsonl](../art/gen-log.jsonl) | 98 条生成 / 处理记录，其中 68 条带 prompt；保留正负提示、seed、采样器、尺寸、步数和文件哈希。不是所有记录都属于当前采用图。 |
| 应用当前采用基准 | [首次采用](../art/retouch-adopted.json)、[第二轮采用](../art/retouch-round2-adopted.json) | 内含来源及精修提示；按 runtime 路径追溯实际使用图，而非按目录名判断新旧。两份清单分别 10 / 5 项，后者包含对前者的更新。 |
| 差分采用与精修词 | [差分采用](../art/retouch-deltas-adopted.json)、[可提交的记录副本](../art/deltas-records/) | 19 张差分已采用；本次逐项核对 runtime SHA 全部一致。原记录副本含 72 个 JSON、12 个独立提示词文件。 |
| 完整差分制作工作区 | [本机审图页](../art/retouch/2026-10-18-face-deltas/review.html)、[制作说明](../art/retouch/2026-10-18-face-deltas/README.md) | 每张有 NovelAI 输入 / 参数、GPT 编辑词 / 原输出、最终合成与审核。该目录被 Git 忽略，本机存在不等于 fresh clone 会带上。 |
| 电影冻结资料 | [冻结包说明](../art/film-frozen/2026-10-17-v1/README.md)、[provenance](../art/film-frozen/2026-10-17-v1/provenance/) | 本机保留 47 张选片、49 个槽位及历史候选 ZIP；电影服装、镜头和光线不直接替代应用室内基准。冻结包同样是本机制作资料。 |
| 比赛详细美术规格 | `hackathon-2026-final:docs/art-spec.md` | 完整旧规格仍在冻结 Git 对象中；当前 [art-spec](art-spec.md) 是维护版。旧方案、临时例外和当时待办不能自动变成新制作要求。 |

旧差分目录 README 写“等待用户审核”，是交付当时的快照；后来已由 `retouch-deltas-adopted.json` 记录采用。不能仅凭旧 README 把已采用资产退回候选状态。

只读查看旧详细规格：

```powershell
git show hackathon-2026-final:docs/art-spec.md
```

本机另有 `D:\lca-workspace\lca-art\gen\` 与 `D:\lca-workspace\lca-art\tools\`，原设定图和 `nai_gen.py` / `nai_augment.py` 等历史工具仍在。室内原设定图为 `1016-170332_sheet-home_271828.png`，外出服为 `1016-170343_sheet-out_271828.png`，合成设定图为 `design-sheet-v1.png`；它们不随当前仓库保证分发。

比赛时的 Node 脚本也完整保留在 `hackathon-2026-final:film/nai.mjs`（初次提交 `31b825a`），配方在同引用的 `film/prompts.json`；整理时移出了当前工作树，不是丢失。其生图地址为 `https://image.novelai.net/ai/generate-image`，Director Tools 为 `/ai/augment-image`，本机凭据位置是 `secrets/novelai.json`，该文件仍存在且被 Git 忽略。旧工具里关于套餐 / 免费额度的注释只代表当时，不作为当前费用承诺。

用户于 2026-10-26 明确要求恢复用已有 key 和端点的脚本路线。新的单张入口 [novelai-single.mjs](../art/tools/novelai-single.mjs) 从上述工具复用请求格式，由本地脚本在运行时读取凭据，不输出凭据或原始错误正文；每次只请求一张，没有自动重试，已有回执拒绝覆盖。先 `--dry-run` 验证公开配方而不读凭据、不联网，实际调用须有对应任务授权。此入口用于维护者美术制作，不改变应用内的主进程权限规则。首张真实请求 HTTP 200，5.2 秒得到 1024×1024 PNG；记录见 [本轮候选目录](../art/retouch/2026-10-26-team-room-v1/)。

## 可以复用的提示词基础

以下从 `gen-log.jsonl` 的室内设定图记录提取，供新候选组装；新构图和子代理尺度仍需共同确定。

画风基础：

```text
colored lineart, thin lineart, flat color, pastel colors,
hard-edged lavender shadows under hair and in clothing folds, one shadow tone,
single light source from the upper left, shadows fall on the lower right side of each form,
few large simple shadow shapes
```

角色身份基础：

```text
young adult woman, college student, short hair, chin-length bob,
soft hair ends curling slightly inward, pastel peach pink hair,
light pink hair with a warm peach tint, greyish amber eyes,
muted light amber eyes with a soft grey tint,
a thin dark navy ribbon tied in her hair on the left side,
two short ribbon tails hanging straight down like a bookmark ribbon
```

应用室内服装基础：

```text
white blouse with a small rounded collar, cream knit cardigan,
pale lavender long skirt reaching the calves, white socks, light grey indoor slippers
```

“她的左侧”不等于画面左侧；视角变更时要对着已采用图核对丝带位置。外出披肩、小金扣和乐福鞋属于另一套记录，不混入室内模板。新全景的小人物应保持身份与成人角色设定，不能未经讨论把“小桃子”直接解释成另一种年龄或画风。

历史设定图参数：`nai-diffusion-5-full`，`k_euler_ancestral`，23 步，scale 5，seed 271828，1216×832。它们是当时实际使用值，不表示当前套餐、费用或新构图的最佳参数已验证；同 seed 不能保证跨版本或新构图完全一致。

局部差分的实际参数示例见 [NovelAI 眨眼记录](../art/retouch/2026-10-18-face-deltas/desk-computer_calm__blink-nai-record.json)：768×768 工作裁切、strength 0.32、noise 0.02、23 步、scale 5。它是局部编辑配方，不直接拿来生成整个新房间。

## 精修与采用

GPT-image 精修词通常明确四件事：哪张是编辑目标、哪张只提供身份参考、目标改动、必须保持的部位。可复用结构见 [应用首轮精修 manifest](../art/retouch/2026-10-16-v1/manifest.json) 及 [眨眼精修词](../art/deltas-records/desk-computer_calm__blink-gpt-prompt.txt)。

实际顺序为先审 NovelAI 构图 / 姿势，再把底稿与已采用身份基准交给 GPT-image 修正头颈、手部、透视、表情或光照。提示词写“保持”不能当作像素不变的证明：面部差分检查明确区域以外的像素，整帧夜景检查构图与光源，最终以应用尺度下的组合效果为准。原图、模型原输出、提示词、输入 / 输出 SHA、候选与采用状态分别保存。

历史 GPT-image 回执没有报告具体模型版本，不把文件里的 requested_model 当成已验证版本。后续继续按实际工具返回的信息记录。

## 这次子代理场景从哪里继续

已有共识是“书左页拉远到全房间，一群小桃子一起忙碌”，见 [1.2 计划](research/v1.2-development-plan-20261023.md)。旧 `wide/` 保留睡姿和空景，但不构成本次团队远景设计。

下一张先确定全房间构图与可见成员位置：主桃子与原书桌如何保留、小桃子的比例与工作位置、不同人数如何排布。先做一张白天候选确认透视和身份，再拆背景 / 人物与状态差分，随后补夜间、等待和失败等表现。具体布局、比例、自动切镜节奏仍为待讨论内容。

2026-10-26 用户对照现有 LCA 画面确认了书桌方向：**短边靠窗台，长轴由窗台伸向房间前方，桃子坐右侧长边工作**。远景应延续这个空间关系；电脑 / 本子面向她，双膝位于长边两条角腿之间。房间摄像机是斜视角，“伸向前景”不等于桌子正对屏幕，桌面与桌腿必须跟随房间的透视。此前横桌与正面桌都是错误候选，不能当作已批准房间布局。

新候选位于 [2026-10-26-team-room-v1](../art/retouch/2026-10-26-team-room-v1/README.md)。用户选择先只画房间与主桃子、为分身留位置，比例以后确定。v1 已完成 NovelAI 底稿和 GPT-image 精修；用户认可精修带来的细节改善，但指出构图与桌子结构问题。v2 重排了房间与家具，用户认为更好但仍有腿部穿模；v3 仅针对桌下坐姿与遮挡修订。用户进一步指出书桌朝向根因，v4 改成短边靠窗但仍正对镜头；v5 虽改成斜向桌面，仍被指出整体投影不一致。冻结电影包与已采用图继续作为来源基准；只在维护者确认候选后更新 runtime 素材和映射，尚无新素材采用。

随后用户指出 v5 仍有多视点拼贴：家具、窗框与地面未共用投影。现改用本机 Three.js 的统一相机与实际矩形家具生成 [几何底稿](../art/retouch/2026-10-26-team-room-v1/room-geometry-v2.png)，用户已明确认可其机位和摆放并要求继续精修。v6 按该底稿恢复原 NovelAI 来源的角色与画风；新增一次 GPT-image 调用（累计一次 NovelAI、六次 GPT-image），成图仍待采用。底稿几何校验和成图忠实度分开，见 [叠图审查](../art/retouch/2026-10-26-team-room-v1/review-geometry.html)。不能再以单张好看或提示词中的“统一透视”代替结构检查。

v6 审图后，用户转述 Gemini 对大腿观感、侧面贴片感、腿脚僵硬、屏幕面与硬板椅背的建议。按局部编辑处理：v7 改好屏幕与木条椅背但髋部移动不足；v8 继续将椅子与臀部移近桌沿，模型同时带动上半身 / 头部少量前移，仍待用户审图。当前累计一次 NovelAI、八次 GPT-image 调用，未采用新素材。[坐姿对照页](../art/retouch/2026-10-26-team-room-v1/review-seat.html)保留修改前、中间稿与新候选；转述的外部分析作为审图假设，不代替独立观察或人体测量。

用户认可 v8 更自然，仅要求椅子沿桌长边微调。经澄清，方向为靠近观察者、画面左下。v9 按此方向微调椅子和坐姿落点，待审核；见 [八 / 九版对照](../art/retouch/2026-10-26-team-room-v1/review-alignment.html)。当前累计一次 NovelAI、九次 GPT-image 调用，尚未采用或替换运行时素材。

用户随后明确要求先保留 v9，未来继续优化，并以此讨论子代理表现。现标记为后续探索的保留底图，尚未替换运行时素材；分身的尺度、布局和动作仍待共同确定。[当前建议](../art/retouch/2026-10-26-team-room-v1/subagent-visual-proposal-v1.md)先尝试矮桌两侧的两位小桃子，属于提案。

随后用户提出三分之一正常身高的等比例角色可能丢失细节，明确要求先试 Q 版小桃子。独立候选与小尺寸比较见 [小桃子造型试稿](../art/retouch/2026-10-26-mini-taozi-v1/review.html)。本轮 NovelAI 单次请求为 outcome-unknown，没有新底稿；改用实际历史 NovelAI 居家设定图与已采用身份图，经内置 GPT-image 三次制作比较、简化身体与衣褶、修正标签。不能称本轮取得了新的 NovelAI Q 版底稿。最初二头身 / 二点五头身数值未被严格执行，因此当前标签改为 A 圆短型 / B 稍修长型，具体比例和世界尺度仍待共同确定。尚未选择最终造型、合成进房间或接入运行时；逐版提示词、输出与来源哈希分别保存。

2026-10-27 起改为分层制作：房间与主桃子用三维底稿做 NovelAI 图生图，小桃子先定 Q 版造型再按状态出白底单人图，GPT-image 只做局部精修。原因分析、提示词、参数和验收清单见 [团队画面制作方案](../art/prompts/2026-10-27-team-room.md)。v1–v9 与小桃子试稿保留为记录，不作为新方案的起点。

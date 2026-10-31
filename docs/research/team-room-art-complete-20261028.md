# 团队远景：美术补齐与运行收尾（2026-10-28）

用户认可带凳子的茶桌预览后要求先补齐团队艺术资源、让小桃子正确反映子代理并验证团队运行；大小桃子画风统一后置。本轮完成该范围的源码与素材接入，不更新全局记忆，不发布或重新打包。

机器可读摘要见[验证记录](evidence/team-room-art-complete-20261028.json)。

## 结果与证据

| 范围 | 当前结果 | 证据 |
| --- | --- | --- |
| 团队素材 | 16 张版本化 PNG 已采用：茶桌 4、书架 2、书桌 2、进门 / 待机 2、思考 / 等待 / 失败 / 完成 / 休息 / 停止 6；旧图保留 | [manifest](../../src/renderer/src/assets/character/taozi/team/manifest.json)、[凳子提示词](../../art/prompts/2026-10-28-team-stools-imagegen.md)、[补齐提示词](../../art/prompts/2026-10-28-team-complete-imagegen.md) |
| 类型 / 静态边界 | `pnpm typecheck`、`pnpm lint` 通过 | 本轮工具输出 |
| 单测 | 91 文件、673 项通过，使用 `--maxWorkers=1` | 本轮工具输出；首次默认并发有一项临时文件 rename EPERM，单独 8 项与随后全量复核均通过，未改动相关扩展模块 |
| DSH 协作 | 12 项通过，实际固定 DSH 引擎 + 本地合成模型 | `.cache/team-v2-temp/lca-collaboration-probe-sdMuX4/`，`exit.json` 为 0 |
| 构建 | `pnpm build` 通过 | `test-results/team-v2-preview/build.log` |
| 完整 Electron 流程 | 11 项通过，包括断线后同一操作核对、冷恢复与房间步骤卡片，`teamOnly: false` | `test-results/p5-9ae27dd7-a457-457b-8745-0d30e67ea179/evidence.json` |
| 视觉 / 交互 | 8 组通过，16 张图、9 位工位、6 位状态、6 位受阻场景、鼠标 / 键盘 / 焦点、隐藏房间、日夜、减少动画、窄窗口 | `test-results/team-v2-preview/report.json` 与同目录 PNG |
| 真实供应商 / 安装包 / 长期体验 | 本轮未运行，不能从合成验收外推 | 沿用独立授权与单独验收边界 |

## 修正

- 茶桌按用户已认可的凳子版落点接入，袖口、手和电脑从同一 PNG 裁出前景层，裙子和凳子留在桌后；无镜像、无替换房间底图。书架人物落脚移至书架前，休息姿态单独缩放以维持头部尺度。
- 等待举纸、思考托腮流汗、失败摊手、停止抬手；状态标记区分批准、回答、额度、恢复、同伴、完成、已停下与结果待核对。新回合不能继承上一回合的完成、等待或失败姿态；未收到结果的历史步骤不再一律标为进行中。
- 并行工具调用按 callId 分别等待结果，先结束的调用不会让其他工具被显示成思考；回合结束清空。步骤详情继续按需只读，受限来源仍不显示目标，不进入快照。
- `appendPluginRecord` 会先触发通知，原实现可能在 flush 前公布 accepted；故障注入此时断开连接，后续 flush 失败又将已执行动作写成 failed。现在已结算回执等待 flush 完成后公布，实际执行后的持久化错误保留 unknown；刷新只重试持久化、核对原 requestId，不重放业务动作。首轮修复后完整流程也已通过一次（`p5-693c026d-a2fb-4695-8389-9faa72e7f0a8`）。
- 鼠标命中可见头部，透明图片矩形不截获旁边成员的点击；保留 Tab / Enter / Escape 与关闭后焦点返回。隐藏房间禁用命中区，避免透明界面挡住桌前视图。

## 原稿与复现

凳子原稿和白底裁切保存在 `art/retouch/2026-10-28-team-table-imagegen-v2/`，沿实际 y=650 分隔切成四格；封闭凳子横档白底按已核对种子去除。其余两张六格表保存在 `art/retouch/2026-10-28-team-complete/`，由 `art/tools/cut-chibi-sprites.cjs` 按 2 行 3 列裁切。原稿、退回版本与本轮前文件备份均保留。本轮补齐用了两次内置 imagegen，连同此前凳子两轮共四次；没有新增外部生成 API 请求。

运行 `node scripts/team-room-preview.mjs` 复现视觉检查；设置 `LCA_SHOT_PORT=5191` 并加 `--serve` 可交互预览，场景为 `team-working`、`team-workstations`、`team-statuses`、`team-blocked`。回归使用隔离数据与本机已安装 Chrome / Electron，不下载浏览器。

此前 READ_RECONNECT 失败证据保留。最终点击方式改变后，中间一次完整回归因冷恢复处仍用旧整图中心点击失败（`p5-d903080e-4202-4583-9b37-3e77c4c2c2b5`），修正为可见头部后完整重跑通过；没有强制点击或跳过断线步骤。开发预览工具条移至顶部以免遮挡书页切镜按钮，此工具条不在实际应用中。

大小桃子的线条、配色统一按用户要求后置；夜间继续用房间调色层。本轮没有证明真实模型能完成复杂项目或长期稳定工作，也未将旧版本真实服务证据移植到新构建。

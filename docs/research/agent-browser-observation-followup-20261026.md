# 浏览器候选补评：Agent Browser 与观察信息量

2026-10-26。用户指出 Agent Browser 的回传信息更精简，需要时再用截图看细节。本轮按 Vercel Labs 的 `agent-browser` 核对，并修订 [首轮评审](plugin-migration-selection-20261026.md) 的选型建议。只读源码和文档；未安装、连接浏览器、运行对比测试或修改运行代码。

**将 Agent Browser 作为下一轮浏览器观察后端的优先候选，BrowserSkill 保留为备选。** 这是按用户偏好调整研究顺序，不是已验证的兼容、token 或成功率结论。本文保留当时的局部补评；随后已完成 [完整迁入评审](plugin-review-agent-browser-20261026.md)，给出 M1 / F2 路线、七项接口和同范围工时，运行与 token / 成功率实测仍未进行。

## 1. 已核对的事实

Agent Browser 固定 `6d6270059bfa34b39719d218486dc9acc7d82823`，package 声明 `0.39.3`；BrowserSkill 沿用前轮 `c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b`。文件引用与 hash 见 [补充证据](evidence/agent-browser-observation-20261026.json)。

| 观察需求 | Agent Browser 当前接口 | 对 LCA 的意义 |
| --- | --- | --- |
| 找操作对象 | `snapshot -i` 可仅输出交互项，`-c` 压缩结构，`-d` 限深，`-s` 限定区域 | 可把第一次观察控制在任务所需范围；不能所有任务都只看交互项，否则正文、说明或表格可能缺失 |
| 补正文细节 | 无 URL 的 `read` 读取当前页面渲染 DOM；`get text` 可读指定对象，read 还支持 outline / filter | 更多文字细节不一定需要图片；指定 URL 的 read 另走 HTTP 获取，不能当作同一次当前页面观察 |
| 补视觉细节 | 普通或标注截图；可按需使用 `--if-changed`，源码截图选项有 selector 范围 | 布局、图表、canvas、无标签图标与视觉验收再看图；截图是否变化不证明操作成功 |
| 接入工具 | 当前 README 描述 stdio MCP 与 core 工具组，也提供 CLI | 可以优先评 LCA 现有 MCP 文本路径，不因它不来自 DSH 市场而绕远路；core 仍含交互和 eval，不能整组当只读白名单 |

来源：[快照说明](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/docs/content/docs/snapshots.mdx)、[README](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/README.md)、[snapshot 实现](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/native/snapshot.rs)、[screenshot 实现](https://github.com/vercel-labs/agent-browser/blob/6d6270059bfa34b39719d218486dc9acc7d82823/cli/src/native/screenshot.rs)。

BrowserSkill 同样支持 `observe / snapshot` 的 `maxDepth / maxTokens`，以及按 ref 读取 HTML 或裁切截图。不能仅从工具数量多推导每次观察必然冗余；两者要在相同页面、目标、范围与预算下比较。[BrowserSkill 参数定义](https://github.com/Tencent/BrowserSkill/blob/c0b8e5704a69aa93f6cdd40bbb286a9dd485d42b/packages/dsh-plugin-browserskill/src/browser-tools.ts#L209)

## 2. 推荐的观察策略

1. 按任务选首次观察：操作定位用紧凑交互快照，读文章用有界正文，读表格保留行列关系。不要机械固定一个最短输出模式。
2. 有缺口时只补相关区域或对象，保留截断 / 不可见范围，不把“没返回”当“页面没有”。
3. 文本不能解决的视觉问题，再取目标区域或当前视口截图；按需标注，避免每次动作都附整页图。
4. 页面发生变化后重新观察与核对目标。已有 ref 或图片没有变，不替代动作结果和当前授权验证。

上述是 LCA 的候选使用策略，后端保留替换空间。两种后端仍需绑定当前用户 / 项目 / 页面与授权；MCP 可调用不等于图片已接入 LCA 的来源退役和隐私路径。现有截图窄出口不能直接推定为通用图片 API。

## 3. 修正之前的比较

之前 BrowserSkill 的 6–10 人日与自建后端的 15–25 人日估算，只比较它和重造 extension / daemon / CLI，**没有与 Agent Browser 做同范围比较**，不能用来证明它是最优后端。补评尚不提供 Agent Browser 工期，避免在未审连接与生命周期前猜测。

两者都存在复用现有登录环境的路径，但 profile / CDP 连接与 BrowserSkill 的借页 / 归还协议不是同一个产品行为。需要完整评审的剩余项是：用户如何选择账号与页面、如何防止操作其他会话、停止后留下什么、重启如何核对、图片怎么进入模型，以及实际制品 / 许可 / 依赖。源码支持某个连接参数不证明用户现有浏览器可以无准备接管。

如果任务主要是 Agent 自己开的页面，先评 Agent Browser 的简洁文本流程；若必须显式借用并归还用户正在使用的标签页，再比较 BrowserSkill 的对象归属机制。不会为使用 DSH 生态而强制经过 DSH 插件包装。

## 4. 对评价规格的补充

除功能正确与权限边界，再记录观察成本：工具定义占用、首次输出长度、信息覆盖、追加观察次数、截图次数与图片输入成本，以及最终任务是否完成。以“完成同一任务的总成本”比较，不能只比较第一次快照最短。

后续可用相同的正文页、数据表格、动态表单、iframe、canvas 五类合成页面比较；固定模型、任务、权限范围与截图预算，完整保留失败和额外观察。当前未运行，不给 token 节省比例。该补充作为 v0.1 的评审反馈，未直接改写原规格或扩大权限。

# Agent Browser 首次迁入验证：网页调试

2026-10-28。用户已选定 Agent Browser 为首个迁入 LCA 的插件，授权继续验证；目标是让桃子调试用户项目的开发网页。**选型已确定，运行验收尚未通过，插件没有启用。** 本文承接 [完整迁入评审](plugin-review-agent-browser-20261026.md)，不把此前源码研究改写成运行成功。

## 本轮结论

已下载并校验官方 Windows 发布程序，在本机临时页面 / 新浏览器资料上运行验证。0.39.3 与当前 0.40.0 都在浏览器启动阶段失败，尚未取得页面结构或截图。直接启动现有 Chrome / Edge 的 Playwright 对照通过，且保留 Chromium 沙箱。**故障与 Agent Browser 启动路径、运行环境组合有关，具体根因还没有确认；不能据此宣布所有 Windows 都不兼容，也不能认定是私有桌面、路径前缀或某个权限单独造成。**

按原评审的生命周期门槛，暂不接入桃子的正式工具列表。实验实现只在 `scripts/fixtures/`，没有改动 `src/`、DSH bridge、插件注册、renderer、模型配置或用户资料。第一迁入项目仍为 Agent Browser，没有擅自换成 Playwright；后者本轮只作启动对照。

## 证据矩阵

本地基线：`7916fb2c66d631e5f5d743269abc72173f51b3df`，`codex/1.2-development-plan`。启动时仅有既存未跟踪 `.claude/`，未修改它。DSH 为 `0.2.1-rc.2`。浏览器为本机 Chrome `156.0.8078.48`、Edge `156.0.4314.50`，不使用它们的日常 profile。

| 检查 | 结果 | 证据含义 |
| --- | --- | --- |
| 官方 EXE 的版本、Release digest 与本地 SHA256 | 通过 | 证明取到了所选制品；不等于可复现构建或整包许可清关 |
| 0.39.3，探针持有原生 daemon 子进程句柄 | 失败 | Chrome 在写出调试端口前退出，代表性退出码 `-2147483645`；Edge 尝试超时 |
| 0.40.0，同一类隔离启动 | 失败 | 同样未到页面观察阶段，升级不能直接消除本机阻塞 |
| 0.40.0，上游公开 CLI + 显式空配置 + 独立 session/socket | 失败 | `Failed to create temp profile dir` / `os error 5`；`close` 也失败，立即核对时 daemon 仍活着 |
| Playwright 启动现有 Chrome / Edge，全新 profile、`chromiumSandbox: true` | 通过 | 对照程序可运行；没有把 Playwright 结果算成 Agent Browser 成功 |
| Playwright 使用上游 Windows 启动代码采用的扩展 EXE 路径前缀 | 通过 | 单独使用该前缀不足以解释失败；没有排除其他启动差异 |
| 极简且改写 Windows 用户目录变量的启动对照 | 失败 | 该环境自身也能造成问题，故不能把所有错误都归因于上游；该诊断变体不保留为默认脚本 |
| 最终失败分支的自有 daemon 退出 | 通过 | 最后一份回执明确记录 `daemonExited: true`，仅 `ESRCH` 算已退出 |
| 收尾独立进程核对 | 匹配数 0 | 按本轮 EXE 路径、唯一测试 profile 路径核对；不夸大为已经证明所有异常场景的完整子树回收 |
| 文本 / 截图关联、DSH 图片传递与退役、审批 / 跨项目 / 停用反例 | 未运行 | 启动前置条件未过，不用模拟成功替代真实后端证据 |

[汇总证据](evidence/agent-browser-validation-20261028.json)索引了全部 16 份本轮诊断回执及 SHA256：11 次原生 daemon 尝试、1 次公开 CLI、4 组启动对照。13 份失败、3 份通过包含不同条件和诊断改动，**不是 16 个独立性能样本，也不是插件兼容率**。原始回执保留在被 Git 忽略的 `test-results/`，失败没有删除。

本轮未运行真实模型、外部网站、登录、学校扫描或付费服务；没有运行 `playwright install`、npm 全局安装、系统权限修改或关闭 Chromium 沙箱。

## 制品与版本差异

| 版本 | 标签对应提交 | Windows x64 EXE SHA256 |
| --- | --- | --- |
| 0.39.3 | `bac577a80442fd00f6f1756e5852a5194d53ff21` | `b02d9566716f5936fcd6e69e84d3e8137711e99e384131e244f1bfe187d30af7` |
| 0.40.0 | `c3880a7de9be3b075c8779e8aaca4b530b7f0e10` | `b142ca8946efda2d506e0947b232596e7949f08296e6b953b57f63eb50fee751` |

来源：[0.39.3 Release](https://github.com/vercel-labs/agent-browser/releases/tag/v0.39.3)、[0.40.0 Release](https://github.com/vercel-labs/agent-browser/releases/tag/v0.40.0)。EXE 仅位于项目 `.cache/agent-browser/<version>/`，没有进入 LCA 分发包或自动更新路径。

上次评审的源码提交 `6d6270059bfa34b39719d218486dc9acc7d82823` 比 0.39.3 标签多三次提交，包括跨域 iframe 与高 DPI 整页截图修复；这些修复在 [0.39.4 Release](https://github.com/vercel-labs/agent-browser/releases/tag/v0.39.4) 才正式发布。0.40.0 又修复了 Windows 同名 session 在不同 socket 目录之间的串连等问题。两个实测版本的 Windows `windows_process.rs` 内容相同，但这不能证明其他启动代码完全相同。

上游 [Windows 启动问题 #1710](https://github.com/vercel-labs/agent-browser/issues/1710) 与 [提权启动问题 #1406](https://github.com/vercel-labs/agent-browser/issues/1406)提供诊断线索，都是其他环境的报告，不能当作本机根因。未采用其中的日常 profile、外部 CDP 接管或关闭沙箱建议。

## 本次确认要调整的适配设计

1. **先验实际发布包，而不只验同版本号的源码分支。** 以后每份迁入回执绑定 tag commit、EXE hash、操作系统 / 浏览器组合；不能从较新源码推定较旧制品已修复。
2. **CLI 生命周期不够。** 普通命令启动独立 daemon，CLI 返回并不表示浏览器结束。实验尝试由 LCA 直接持有原生 daemon 的子进程句柄与私有端点，以验证取消和清理的控制点。它属于待验证适配方向，不是已经采用的稳定接口；生产版不能开放该通用内部 RPC。
3. **`session_info` 和 `close` 不能先验当作无副作用检查。** 实测启动阶段也会进入浏览器自动启动；公开 CLI 的 `close` 返回错误后 daemon 仍存在。最终实验在启动失败后直接结束自有 daemon，避免用 `close` 再引发自动启动。之后仍需独立验证 Chrome 子树与异常退出。
4. **本地开发页增加了网络授权问题。** 用户选择项目文件夹并不自动授权电脑上的所有 localhost 服务；上游 hostname allowlist 也不等于指定 origin / 端口。正式接口必须绑定本次批准的开发页 origin，覆盖重定向、新标签、iframe、WebSocket、资源请求。未验证前不能把“仅 localhost”写成隔离完成。

## 首版功能与核心流程边界

选定的首版能力：对用户批准的项目开发页采集结构、局部正文、console / page errors；按需附一张视口或区域截图。以**一次观察**为最小对象：新建临时浏览器，在同一 target 下依次采集，返回观察 ID、页面身份、每项采集时间和范围，然后关闭。动态页面的文字和图片可能有时间差，不承诺原子快照；身份变化应拒收该组合并重新取得授权。

结构 / 正文用于理解控件、标签、表格和报错，截图补充布局、遮挡、颜色与 canvas。不是每一步都发图片；模型不能接收图片时应明确返回该能力不可用。文本与图片都算外部来源，同一观察一起退役，图片必须走真正的图像内容块，不能把 base64 或文件路径当成“模型看到了截图”。

以下公共接入尚未实现：

| 接口 | 对 LCA 的具体要求 |
| --- | --- |
| 项目 / 回合 / 浏览器对象授权 | main 绑定 user、character、data root、project、DSH runtime/root/member、当前 activation 与批准版本；首版只开放主角色，成员默认拒绝 |
| 工具调用与取消 | host 验证后的 origin 传给能力层；DSH 单次取消、停止、断连和插件停用传播到实际进程；取消不自动重试外部动作 |
| 受限浏览器执行 | 固定制品、有限命令、输出 / 时间 / 资源上限，显式端点与环境；对象隔离、进程身份和清理独立验收 |
| 网页来源 | `browser.*` 明确标为 web；读过页面后，后续改代码 / 跑命令沿用 DSH 每步审批，不绕开现有降权规则 |
| 图片与额度 | main 校验并限定图片尺寸 / 字节数，传输真正的图像块；检查当前模型输入能力和额度；退出当前授权后清理模型投影 |
| 隐私 | 现有校园结构化隐私 schema 不能清洗任意 DOM / 图片；独立隐私模式先明确拒绝，而非静默切换主模型 |
| 书本与插件开关 | 沿用工作对话、批准卡、停止按钮及插件页；只投影目标、活动 / 清理状态，不添加第二个 agent loop 或上游 dashboard |

首版暂不含点击 / 填表 / 上传下载、eval、任意 CDP、账号恢复、日常标签页、网络改写或持续浏览会话。这些是后续独立评审的能力，而非现在换内核就获得的权限。当前没有改变桃子的主模型交接、专注节奏、记忆、角色生活或项目工作流程。

## 成本与下一门槛

原来的 9–14 人日与 Playwright 11–17 人日是同范围规划估算，预期中位差约 2–3 人日。**本轮没有证明节省；新增的 Windows 启动兼容成本尚无法定量，不能继续把“两成”写成已获收益。** 若必须维护 Rust 启动器 fork，需计入 M2 的构建、许可证告知、Windows 回归与升级合并成本，再比较同范围 Playwright 方案。启动对照通过也不等于 Playwright 全插件更划算。

下一门槛仍是一个可解释、可复现的 Windows 启动修复，且不牺牲来源、网络授权或进程所有权。通过后再执行既定页面矩阵、文本 / 图片关联、完整取消和实际 DSH 本地脚本模型链路。本轮未越过该门槛去做正式注册或打包，也未把未通过项目写为能力已交付。

## 复现与静态检查

依赖项目现有 Node / Playwright，以及放在固定缓存路径、hash 匹配的官方 0.40.0 EXE。不自动下载依赖，不读取真实模型配置。

```powershell
node scripts/agent-browser-probe.mjs
node scripts/agent-browser-cli-control.mjs
node scripts/agent-browser-launch-control.mjs
$env:LCA_PROBE_CONTROL='extended-path'
node scripts/agent-browser-launch-control.mjs
```

前两项在本机目前预期失败，应保留返回码与 receipt；CLI 探针会报告关闭时的存活状态，不能把它当完成。所有探针写独立 UUID 目录。生产路径未改，未运行无关的 Electron 全套或真实服务回归。新增脚本的 ESLint、实验 fixture 的 TypeScript 检查及文档 / whitespace 核对通过。

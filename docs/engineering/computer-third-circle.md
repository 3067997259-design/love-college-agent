# 隔离书桌预览与有界 computer use

接口 `65dc9b4` 先合 main：heartFlow.computer 及 flow.computer.open/close/approve。沿用用户确认的“仅书桌、运行逐次审批”边界：用户明确选一个书桌静态 HTML，模型只观察该预览／提议单个点击、文字输入或少量具名按键，动作每次人工确认。不是整机控制，不连接已有应用实例。真实外部应用目标仍待用户给出；未回答时仅做这个隔离场景。

目标是独立临时 session 的 OS sandbox BrowserWindow，无 preload／Node／IPC／webview；固定 CSP 关闭脚本、网络、子框架、worker、对象、表单外发和 base 改写，原生拦截导航、下载、弹窗与权限，文件输入禁用。这是安全静态预览，不宣称可运行任意 JavaScript 应用。800×600 逻辑坐标，PNG 归一化到同尺寸；用户 CSS 动画／过渡／光标闪烁关闭。不是用 cwd 充当沙箱。

## 动作与证据

仅 execute、非展位、未熄灯时用户可开一个合法 desk HTML（最多 64 KB）；模型没有开目标工具。`desk_computer_observe` 捕获真实 PNG，`desk_computer_action` 仅提一个 click、单行 type（≤80 字）或 TAB/ENTER/ESCAPE/BACKSPACE。每次带最新不可复用 frameRef，主进程用源文件指纹、flowId、开窗 generation、当前 DOM／表单／焦点／滚动／尺寸指纹再核对；人工批准只对这一个动作。用户改变页面或文件就拒绝。新截图即有新的不透明 ref，像素相同也不复用旧批准。

每窗 8 个动作／20 帧，开窗十秒、截图五秒、等待审批三十秒；取消／超时关闭预览，迟到打开／截图不产新证据。逐次审批可经现有通知规则提醒专注中的用户。停止、退出、熄灯、禁用 coding、改为 plan、换目标或用户关预览均失效；重启不自动开窗／重播审批。dispatch 仅证明输入已发到所属预览，下一帧核对后才可判断任务；本身不等于页面业务成功。退出摘要只给观察／派发／拒绝／失败／取消次数和该范围，不含页面或输入原文。

## 私有图像通路

工作截图有独立 journal 元数据和受哈希校验的 PNG，未登记到公共 asset/stored 素材 broker；拿到快照 hash 也不能从 lca-media 读图。模型 resolver 只接受当前 flow 所属 work-frame。成功 tool/result 和 model/seen 只记 ref，不把 PNG base64 塞日志。普通上下文仍排除整个工作过程，eligibleIndexes=[]；私人 ZIP 单独收集／校验这些 PNG，恢复不复活窗口或许可。

兼容客户端把 PNG 编成 user 的 image_url/data URL、detail=low，保留原始 tool 回复，整批工具结果都齐后才追加图像消息；不允许任意文件路径或外部图像 URL。每次输入只保留最近两个不同工作帧，单帧 128 KiB，另保守预留每图 16384 输入预算单位；这不是供应商价格或 tokenizer 保证，实际 token 缺失仍为未知。协议参考：[OpenAI Chat Completions 图像内容](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)，2026-10-17 核对。实际配置模型是否支持视觉仍待真实验收，不自动换模型。

## 已跑验收

类型／lint、55 文件／322 项单测通过；之后补一项新插话取消旧待批动作，computer 定向 10 项通过。使用真实 schema、journal、desk 与资源文件，覆盖逐次许可、拒绝、页面／源文件变化、取消／超时／阻塞／重启、动作和帧数、字段／按键、私有资源、迟到打开／截图；PNG 单测只验封套，真实像素另在 Electron 验证。客户端另测工具批次顺序和未授权图像 fail closed。

`node scripts/smoke-computer.mjs` 实际通过：独立静态页面无脚本／网络／文件选择／bridge；真实 PNG 经本机合成多模态 HTTP 送入客户端；两次原生用户确认后真实点击和输入，字段值改变、图片改变、Markdown 草稿落盘；旧批准拒绝、手工改页面后审批拒绝、停止关窗、重启不残留，PNG 私人导出／恢复、公共 broker 404、普通上下文排除。基础 Electron、心流和分身回归通过。请求只到自有 loopback，模型是合成，不把它当作真实视觉质量／整机控制验收。命令 `pnpm test:computer`；尚未重打安装包。

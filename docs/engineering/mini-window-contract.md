# 迷你窗最新版主进程与诊断入口

2026-10-16 23:38。按用户本轮版本替换旧窗口参数；画面仍由 Claude 维护。本轮未调用真实模型或邮箱。

## 接口交给 Claude

接口提交 **`130e857`**（`接口：定义迷你窗 moveBy 与独立开发诊断窗口`），已先合 main `078124e`。主进程实现 **`b74ea13`**，已合 main **`ea1bc44`**。

共享命令在 `src/shared/commands.ts`，契约说明在 `src/shared/README.md`。Claude 请先拉 main，再把 `src/renderer/src/companion/MiniApp.tsx` 接到下面三条：

| 命令 | 主进程行为 |
| --- | --- |
| `window.expand` | 回到书本并销毁小窗；重复操作也不会留下隐藏的小窗 |
| `window.mini.hover { over }` | 只接受真正小窗发送。true 关闭点穿，false 恢复 `setIgnoreMouseEvents(true, { forward: true })` |
| `window.mini.moveBy { dx, dy }` | 只接受真正小窗发送。两个分量为整数屏幕物理像素，每次限 ±10000；主进程按当前显示器 scaleFactor 换算逻辑位移并限位 |

渲染层每帧最多发送一次 moveBy，累计位移后取整。现有 `screenX/screenY` 差值是 CSS 逻辑像素，在默认页面缩放 1 时需乘 `devicePixelRatio` 得到物理像素；别直接改命令名却继续发送旧单位。小于一个像素的渲染端余量也应留给下一帧。主进程继续累计换算到 DIP 后的小数余量，150% 缩放下连续小步不会丢失。

`window.book` 和 `window.mini.move` 暂保留兼容，后者仍按旧 DIP 单位解释。本轮没有修改 Claude 的 MiniApp／拖动组件；现有纸片按钮仍走兼容入口，新三条接线由 Claude 完成。不要增加 `-webkit-app-region: drag`。

## 原生窗口与位置

独立 BrowserWindow，内容区 **280×350 DIP**，frame false、transparent true、alwaysOnTop、skipTaskbar、不可缩放。同一 preload、sandbox、contextIsolation 与主进程 bridge 白名单。用 showInactive 显示，不调用 focus。

默认主显示器工作区右下角，留 24 DIP。位置写当前 profile 的 settings.json，字段为 `miniPosition: { x, y, displayId }`，不跨开发／正常 profile。moveBy 夹在移动开始时所在显示器的工作区内，不能通过大位移跳到旁边显示器；保存去抖 500ms，展开和退出立即落盘。重启只开书本；下次打开小窗时，合法位置复用，原显示器缺失或位置越界则回主屏默认角落。运行中显示器变更会重新限位。

本机 150% 缩放暴露了 Electron 的原生取整问题：直接 setPosition 会把 frameless 窗口越挪越大。现在统一 setContentBounds，一次设置位置和固定内容区大小；限位给原生外边界留 2 DIP 余量。自动化容许内容区 ±1 DIP、默认边距 ±2 DIP 的系统取整，工作区内完整可见的断言不放宽。

原有 `LCA_MINI_OPAQUE=1`、GPU 不可用／崩溃和连续黑角检测的不透明圆角回退继续可用，展位模式也支持。模拟黑色 capturePage 只验证回退分支，不代表真实显卡故障验收。

## 时机与保守处理

| 状态变化 | 窗口处理 |
| --- | --- |
| 开始新的专注段 | 书本隐藏、小窗出现；改草案或专注中确认替换计划不会再次收起用户已展开的书本 |
| 短／长休息开始 | 保留当前窗口；小窗中的铃声、转身和一行工作状态继续由渲染层显示，书本不会自动弹出 |
| 用户点她／window.expand | 打开书本并销毁小窗 |
| 停止计划 | 保留当前窗口，不强行展开；只停止已确认计划，不丢草案 |
| 熄灯 | 保留当前窗口，计时与后台工作按既有规则暂停；不把“熄灯”改成“睡姿” |
| 应用退出／重启 | 销毁小窗与独立诊断窗；重启只开书本，计时恢复按存下的计时事实处理 |

## 独立开发诊断

开发模式下，`工具与设置 → 开发诊断 → 独立窗口` 打开 `?view=diagnostics`，重复点击复用窗口。专注时书本隐藏，诊断窗仍保留；它展示最近 30 条安全执行活动及已有模型投影、回合、队列、inbox、记忆检索诊断，跟随事件最多每秒刷新一次，不推进业务时钟，不发模型请求。

独立窗为只读：主进程在请求去重之前拒绝其全部 dispatch，另拒绝 readEvidence、readSession 和原生文件导入。安全 snapshot／事件与 readDiagnostics 可以读。正常模式、展位模式均在主进程拒绝 `window.diagnostics.open`，不是只隐藏按钮。调试数据继续按已有诊断投影脱敏；不提供原始日志读取。

## 本轮实际验证

实际执行：`pnpm typecheck`、`pnpm lint`、`pnpm test`（31 个文件／140 项），以及 `pnpm exec electron-vite build --logLevel warn` 后串行运行 `node scripts/smoke-mini.mjs`、`node scripts/smoke-pomodoro.mjs`，均通过。最后合入 main 的获批美术后，重新构建并再次通过 smoke-mini；它还检查小窗和诊断窗同时存在时退出，下一次启动只剩书本。

日常完整入口仍是 `pnpm test:mini` 和 `pnpm test:pomodoro`，两者会自行构建；无需安装 Playwright 浏览器。

- 新增 5 个单测：默认角落、失效位置／显示器、150% 缩放连续 150 次一像素移动、当前屏限位与反向恢复、诊断命令不可借已接受 requestId 重放。
- Electron：真实窗口／同 preload／sandbox、showInactive、不抢焦点、默认与 hover 后原生点穿调用、无系统拖动区、moveBy 整数及发送窗口校验、物理单位换算、限位、位置与显示器 ID 落盘、越界与原显示器缺失归位、休息保留、纸片与 expand 返回、重启无残留。
- 诊断：实际按钮、重复打开复用、书本隐藏时安全工具活动与回合刷新、命令拒绝、证据／会话读取和实际原生 File 导入拒绝、正常／展位模式拒绝。
- 番茄回归：条目／独立草案／当天进度、专注中确认不中断、暂停／熄灯／停止与休息保留小窗、展位不透明回退、合成黑底替换。

真实桌面上点穿到其他应用的手感、物理显示器热拔插和真实显卡兼容仍需人工验收；本轮用当前实际屏幕加合成失效存档与纯函数多屏用例。22:47 安装包尚未重打，不含本轮窗口更新。IMAP 继续记 blocked。

# 番茄计划条目与迷你窗增补

2026-10-16，第一圈收尾之后的用户追加任务。接口提交 `2995860` 先合 main `250e463`；条目实现 `e897e1c` 和校验修正 `8e6ed97` 已合 main；窗口实现 `112a1e0` 合 main `3495970`，高 DPI 归位修正 `1628598` 合 main `ff8fee0`。同时集成 Claude 的羽毛笔、计划条目画面；本批 GPT 不改她的画面、路由或提示词。

## 计划条目

`PomodoroPlanInput.items` 可省略，兼容旧计划。提供时为 1–24 条，每条 `{ text, count, assist }`：

```json
[
  { "text": "整理课程资料", "count": 1, "assist": true },
  { "text": "自己完成练习", "count": 2, "assist": false }
]
```

text 非空、不全是空白、单行且不含控制字符，按 Unicode code point 最多 40 个；不改写通过校验的文本。count 是 1–24 的整数，全部 count 之和必须等于 plannedCount。assist 必须为布尔。`PomodoroPlanView` 在提议、确认、计时、持久重放中原样保留条目。

用户 IPC、`plan_pomodoros` 校验与 service 都使用同一 planSchema。工具 JSON schema 同时声明 items 结构和长度／计数范围，求和由代码执行。超长、不一致、空数组、非法 count／assist 均拒绝，不能追加计划事实。工具仍不能代用户确认计划。

## 主进程窗口行为

| 事件 | 窗口与计时 |
| --- | --- |
| 新专注开始 | 隐藏书本，显示独立置顶迷你 BrowserWindow，一段只自动收起一次 |
| 短／长休息开始 | 保留当前窗口，不自动展开或抢焦点；铃声、转身归渲染层。按本次用户要求，长休息也保留小窗，覆盖 §3.5 较早的自动打开说法 |
| 手动暂停 | 保留当前窗口，只暂停该段计时 |
| 停止计划 | 保留当前窗口、切休息状态；不在桌面突然展开书本。小窗仍可点击返回 |
| 熄灯 | 保留当前窗口，计时／所有后台按既有逻辑暂停，房间灯光由快照呈现；不把熄灯伪装成睡觉 |
| 再开灯 | 只恢复原因为 lights 的暂停，不改变窗口、不恢复手动暂停 |
| `window.expand` | 显示书本并实际销毁小窗，不再只是 hide；`window.book` 保留为兼容别名 |
| 应用重启 | 只打开书本，不恢复上次小窗；计时继续按持久事实核对。退出时销毁小窗并刷入位置 |

小窗只加载 Claude 的 `?view=mini`，使用同一 preload、受限 bridge、会话、计时与 harness。sandbox、contextIsolation 开启，Node 关闭；展位模式也可用，不需要 CDP 或调试 MCP。

首次显示即 `setIgnoreMouseEvents(true, { forward: true })`；只有实际迷你窗口的主 frame 能发 `window.mini.hover { over: boolean }`，over=true 时调用原生 API 变为可点，离开时恢复穿透。书本伪造 hover／move 拒绝。当前 Claude 按纸片区域报告悬停；图形轮廓和命中区域仍归界面线。

位置保存于当前 profile 的 settings.miniPosition。拖动夹在所在显示器 workArea；新建时若旧位置所在显示器不在，归到最近的可用屏幕内；display-added／removed／metrics-changed 也重新夹限并持久化。只保存 x/y，不把位置当记忆或导入到私人存档。

## 透明失败回退

默认透明无框。回退会使用原生不透明纸色背景和圆角窗口区域，重新加载相同 mini 路由，无须改 Claude 的画面：

- `LCA_MINI_OPAQUE=1`：强制回退，公开状态 reason=forced。
- GPU compositing 不可用：回退 gpu-unavailable；GPU 进程异常退出：回退 gpu-crash。
- 迷你页初次显示后由统一 UI 时钟安排两次有限采样；四个应透明的外角都呈不透明黑色才触发 black-background，销毁旧窗并创建不透明窗。透明黑像素和深色的内部画面不触发。

PowerShell：

```powershell
$env:LCA_MINI_OPAQUE = '1'
pnpm dev
# 退出该实例后取消强制：
Remove-Item Env:LCA_MINI_OPAQUE
```

API 依据为 Electron 官方 [原生窗口交互与点穿](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)、[BrowserWindow.setShape](https://www.electronjs.org/docs/latest/api/browser-window#winsetshaperects-windows-linux-experimental)、[NativeImage.toBitmap](https://www.electronjs.org/docs/latest/api/native-image#imagetobitmapoptions)、[GPU 事件](https://www.electronjs.org/docs/latest/api/app#event-child-process-gone)。Windows 不透明圆角通过 setShape 的原生区域保证；此 API 在上游标为 experimental，代码不假设所有系统都支持 DWM 圆角。

黑角采样是有限启发式：如果窗口捕获正常、只有系统合成到桌面时出黑底，无法靠这次捕获保证发现，应使用强制环境变量。没有在本机破坏驱动或诱发真实 GPU 故障，不能将合成故障测试当跨显卡验收。

## 验收

合并 Claude 的新画面后重建：`pnpm typecheck`、`pnpm lint`、`pnpm test` **30 个文件／123 项**通过。Vitest 新增覆盖合法／非法条目、40／41 Unicode 字符、工具与 service 同拒绝且不写事实、确认和重放保持条目，以及透明黑／黑角区分、原生圆角区域几何。

追加极端位置后测出了 Windows 高 DPI 的原生尺寸偏差，已修正为首次 ready 时按实际尺寸再夹限，创建／热插拔／拖动统一保留 2 DIP 余量。修正后重新通过类型／lint、12 项相关单测、完整 `test:pomodoro`（含越界 profile）与 `test:mini`，没有用删掉断言来放过越界。

`pnpm test:pomodoro` 现在包含实际 Electron 双窗口场景：

- 专注时书本隐藏、小窗可见置顶，同一 preload 和沙箱；原生 setIgnoreMouseEvents 调用确实经历 false／true。
- 重启运行中的番茄后只有书本，无残留小窗；后续新专注可重新创建。
- 休息、停止、熄灯保留小窗；window.expand 销毁它，恢复唯一可见的书本。
- 正常展位模式强制 opaque 可用；极端越界的已存位置在当前实际显示器内归位。
- 合成不透明黑色 capturePage 返回值触发真实 BrowserWindow 替换；旧小窗关闭、新小窗唯一且不透明。没有实际 GPU 故障。

同一合并版本的 `test:mini`、`test:backup` 也通过，覆盖原有拖动／位置重启、兼容按钮展开、私人存档完整恢复；原生 pomodoro 探针再次通过。没有读取真实 providers、重试 IMAP 或调用真实模型。实际桌面外部应用点穿、多显示器热拔插和显卡兼容仍需真人验证；本批未重打 22:47 安装包。

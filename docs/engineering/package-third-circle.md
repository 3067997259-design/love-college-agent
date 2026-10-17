# 第三圈安装态收口

`pnpm package:win` 构建当前 Windows NSIS 包，临时目录、electron-builder 和 Electron 缓存沿用 D 盘。`release/build-receipt.json` 绑定实际 Git revision、已跟踪改动标记、安装器和 app.asar SHA-256；构建途中源码改变则拒绝生成回执。回执、包及 test-results 为本机产物，不进入源码提交。

`pnpm test:package` 先核对回执哈希、包内凭据／本地数据排除和解包的 SQLite 原生模块，再做解包版／真实安装版原生探针、普通 profile 重启和历史照片／引用。随后用同一个实际安装 EXE 顺序运行 onboarding、life-work、sleep、flow-drafts、desk-shadow、delegates、optical、minecraft、voice、computer、web-fetch、booth、mini、showcase 和 life-port，共 15 项原生场景。模型／服务为自有合成 HTTP 或 fake，不消耗真实生成额度，也不把通过这些测试当真实模型质量验收。

测试安装目录是 D 盘独立 GUID 目录，预先核对绝对路径归属；已有同名用户安装时拒绝升级／卸载。测试结束只调用自己本轮安装目录的卸载器。各场景使用独立 profile，未加载用户凭据或正常书本；不得为绕过检查删除用户的安装记录。

2026-10-17 07:28 实测通过：七类探针分别跑解包版与安装版、普通界面重启、完整历史照片／引用／私人恢复，以及上述 15 项安装版原生场景，最终 `ok=true`。测试安装已卸载。源码回执 `6571c057a5da9dd8c5afb96e22398f43a1de2c68`，trackedDirty=false，该 SHA 的 CI 也已通过。安装器 238117936 字节，SHA-256 `763c365b563fd5b1285775e5c6c148442376d72bda20c711f7715354e8685b85`；实际 Authenticode 状态 NotSigned。此包替代 07:08 的 4a34e4d 测试包。

本机安装器：`D:/lca-gpt/release/Love-College-Agent-0.1.0-Setup.exe`；构建回执 `release/build-receipt.json`，验收报告 `test-results/package-report.json`。main checkout 的 release 不会随 Git 合并更新。前 13 个场景按独立 profile 顺序跑，showcase 是同一书本的跨功能连续链路，life-port 在普通模式走本机合成 HTTP 客户端验证六步产物、取消、坏输出及隔离。这些场景仍不是五分钟路演观感、真实供应商质量或长期自主运行的证明。

11:55：验收入口已扩至 25 项，收录后续的 flow-sleep、游戏图像／stdio／挖掘、资源账本，以及 questions、desk-command、flow-rewind、settings、failure-narrator。showcase 源码新的七阶段连续链已通过；此次新 NSIS 的构建、实际安装及完整 25 项结果待补，以上 07:28 的包仍只对应当时 15 项，不能混用 SHA 或证据。

12:02：首次新构建 4b8ff51 在解包版 backup 探针处未过，未进入用户安装。定位为旧 backup／heart-flow 验收只等待两次微任务便写文件，未等 #27 后的异步心流准备完成。探针现通过统一 systemClock 让出事件循环并检查 active；没有放宽应用的入睡、写入或存档守卫。源码的七类原生探针随后逐项通过，包含私人恢复／回滚、跨日压缩／多步请求和无限循环终止。安装测试错误现报告固定步骤名与退出码，继续隐藏第三方 stderr。下一包须包含该验收修正，完整结果仍待补。

12:20：af02396 源码包通过两侧各七类探针、普通重启、历史照片和前九项安装场景，随后截图场景未展开新的设置分组而失败；不算新包验收通过。补原生分组点击后针对该 unpacked EXE 的截图全链通过。验收脚本现先撤销旧成功报告，并在失败时记录本次构建回执／失败阶段／已过场景，避免遗留报告误导。审计 #34–36 的修复随后已合 main，接下来重打含修复的新包。

远端 CI 39002112985：类型／lint／492 单测通过，首次 PowerShell 编码正向探针超过其 5 秒窗口（5050 ms），未通过原生命令步骤。仅该正向用例改用产品已支持的 30 秒请求上限；1200 ms 超时、1600 ms 取消及其他隔离断言保留。本机完整 native 探针随后通过；远端需看新一轮结果，不能称旧 CI 全绿。

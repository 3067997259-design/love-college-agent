# 第三圈安装态收口

`pnpm package:win` 构建当前 Windows NSIS 包，临时目录、electron-builder 和 Electron 缓存沿用 D 盘。`release/build-receipt.json` 绑定实际 Git revision、已跟踪改动标记、安装器和 app.asar SHA-256；构建途中源码改变则拒绝生成回执。回执、包及 test-results 为本机产物，不进入源码提交。

`pnpm test:package` 先核对回执哈希、包内凭据／本地数据排除和解包的 SQLite 原生模块，再做解包版／真实安装版原生探针、普通 profile 重启和历史照片／引用。随后用同一个实际安装 EXE 顺序运行 26 项原生场景，包含游戏图像／stdio／挖掘、资源、问答、实际命令、步骤回退、设置、失败旁白与隐私探针隔离。完整名单写入本轮报告。模型／服务为自有合成 HTTP 或 fake，不消耗真实生成额度，也不把通过这些测试当真实模型质量验收。

测试安装目录是 D 盘独立 GUID 目录，预先核对绝对路径归属；已有同名用户安装时拒绝升级／卸载。测试结束只调用自己本轮安装目录的卸载器。各场景使用独立 profile，未加载用户凭据或正常书本；不得为绕过检查删除用户的安装记录。

2026-10-17 07:28 实测通过：七类探针分别跑解包版与安装版、普通界面重启、完整历史照片／引用／私人恢复，以及上述 15 项安装版原生场景，最终 `ok=true`。测试安装已卸载。源码回执 `6571c057a5da9dd8c5afb96e22398f43a1de2c68`，trackedDirty=false，该 SHA 的 CI 也已通过。安装器 238117936 字节，SHA-256 `763c365b563fd5b1285775e5c6c148442376d72bda20c711f7715354e8685b85`；实际 Authenticode 状态 NotSigned。此包替代 07:08 的 4a34e4d 测试包。

本机安装器：`D:/lca-gpt/release/Love-College-Agent-0.1.0-Setup.exe`；构建回执 `release/build-receipt.json`，验收报告 `test-results/package-report.json`。main checkout 的 release 不会随 Git 合并更新。场景按独立 profile 顺序跑，showcase 在同一书本串起跨功能连续链路，life-port 在普通模式走本机合成 HTTP 客户端验证六步产物、取消、坏输出及隔离。这些场景仍不是五分钟路演观感、真实供应商质量或长期自主运行的证明。

11:55：验收入口已扩至 25 项，收录后续的 flow-sleep、游戏图像／stdio／挖掘、资源账本，以及 questions、desk-command、flow-rewind、settings、failure-narrator。showcase 源码新的七阶段连续链已通过；此次新 NSIS 的构建、实际安装及完整 25 项结果待补，以上 07:28 的包仍只对应当时 15 项，不能混用 SHA 或证据。

12:02：首次新构建 4b8ff51 在解包版 backup 探针处未过，未进入用户安装。定位为旧 backup／heart-flow 验收只等待两次微任务便写文件，未等 #27 后的异步心流准备完成。探针现通过统一 systemClock 让出事件循环并检查 active；没有放宽应用的入睡、写入或存档守卫。源码的七类原生探针随后逐项通过，包含私人恢复／回滚、跨日压缩／多步请求和无限循环终止。安装测试错误现报告固定步骤名与退出码，继续隐藏第三方 stderr。下一包须包含该验收修正，完整结果仍待补。

12:20：af02396 源码包通过两侧各七类探针、普通重启、历史照片和前九项安装场景，随后截图场景未展开新的设置分组而失败；不算新包验收通过。补原生分组点击后针对该 unpacked EXE 的截图全链通过。验收脚本现先撤销旧成功报告，并在失败时记录本次构建回执／失败阶段／已过场景，避免遗留报告误导。审计 #34–36 的修复随后已合 main，接下来重打含修复的新包。

远端 CI 39002112985：类型／lint／492 单测通过，首次 PowerShell 编码正向探针超过其 5 秒窗口（5050 ms），未通过原生命令步骤。仅该正向用例改用产品已支持的 30 秒请求上限；1200 ms 超时、1600 ms 取消及其他隔离断言保留。本机完整 native 探针随后通过；远端需看新一轮结果，不能称旧 CI 全绿。

12:28：含 #34–36 修复的 6d6d2e7 安装包通过前 18 项，life-port 的旧场景在上午 11 点后的真实作息登记上失败：重启已保留 interrupted 写作任务，start 幂等不能替代 resume。只改验收为显式恢复已有任务；对同一 unpacked EXE 的普通端口整链已通过，仍严格核对八次请求／六步实际产物／取消／坏输出和普通上下文排除。未改应用重启保护，不需因此重建相同业务二进制；接下来对该包完整重跑 25 项。

CI 39002596878 的失败发生在 #23 配置导入／读回的纯文件系统单测，超过 Vitest 默认 5 秒；未进入 native 阶段。仅该文件系统用例保留 15 秒 fixture 上限，断言和应用期限不变，本机六项配置单测通过。另对已配置 privacy 的 origin 做无凭据 HEAD 诊断，Node 为 ECONNRESET、Chromium 也未连通，系统没有选中代理；没有响应正文或模型调用，不据此修改系统／Clash 或替换运行网络栈。

12:35 最新完整安装验收通过：源码 6d6d2e76edfadd06b8de52a7d355efc09fd23acf、trackedDirty=false；两侧各七类探针、普通重启／历史照片与引用，以及全部 25 项真实安装场景，最终报告 ok=true。包含实际主进程部分写回后强杀、重启数量／摘要与不补写；引用 401 后问题＋锚点恢复并新请求扩读；七阶段同档连续演示及私人恢复。安装器 **238167481 字节**，SHA-256 **e44b413ecdbd09c5f568a80f5c4c37878426d27ea5c25a1eae722cad160d85ae**；asar **6fdbd9fc3e209c484de209992f2935cea6765fa3affdf2c6b9d955f6cd565a56**，实查 NotSigned。测试安装已按本轮 GUID 卸载。此后 main 的差异仅诊断脚本／测试／说明，不能把包的源码 SHA 写成后续 HEAD。

12:50 最新包完整通过：**3edea7cc84084a18fa3c25cada1f0b4600eadb86**，trackedDirty=false；两侧各七类探针、普通重启／历史照片引用、全部 **26** 项实际安装场景，报告 ok=true。新增旧格式引用失败的重开／私人恢复和三槽位隐私探针成功／失败／inspect 隔离；服务仍全为合成。安装器 **238167401 字节**，SHA-256 **85d057f44d12cd84062dd6270ca069c22929dac7f101a8271ea52a86af1fe8f2**；asar **15a46f7d57bd1299833970892ae7eef1363981aa8ed3da383e0389122cba9632**。实查 NotSigned，测试安装已卸载，取代上面的 6d6d2e7 安装器。该源码的 Windows CI **39003562314** 完整通过；本地 69 文件／493 单测、类型／lint 与对应原生链通过。

21:44 新终包完整通过（本机打包，含今晚全部界面／素材改动）：源码 **ba9aedc1a48364c6f4bf5b0c966567fe6bc25dae**、trackedDirty=false；从干净 `D:\lca-gpt` 工作树先 `pnpm rebuild:native` 与 `probe:sqlite`（moduleAbi 149），再 `pnpm package:win`。两侧七类原生探针、普通界面重启／历史照片引用，以及全部 **26** 项实际安装场景 ok=true（含外景页／生活瞬间／19 张差分接入之后的首次安装验证）。安装器 **264,345,609 字节**，SHA-256 **2893bf477e30dfc6b77ad3759a3d1a94c770d300c46fec721145d9834430d12a**；asar **69d0a23af236dbf43c280d4b0a66aba01de5bb65f8a4378ba672c78eb86a6deb**；实测 NotSigned（未签名）；测试安装已卸载。服务仍全为合成，真实模型／TTS／OCR／MC 未因此验收；干净第二台机器与投影／真人观感仍待人工。源码 ba9aedc 的本地类型／lint、73 文件／509 单测与 build 通过；该提交尚未推送，远端 CI 未覆盖。

22:34 新终包完整通过（真实使用修复版）：源码 **efafe5d2a3a5021dddf792c88a06a36ff6b04dff**、trackedDirty=false；相对 21:44 包增加 `get_clock` 的上海本地时间字段与模型 JSON 容错（记忆抽取等任务），并收紧零参数工具描述。首次整轮在第 18 项 `showcase` 偶发退出 1；单独重跑 `smoke-showcase.mjs` 七段全过，随后整轮 **26/26** 通过（报告 ok=true，21:44→22:34 约 15 分钟）。安装器 **264,346,098 字节**，SHA-256 **61492b4cf67caeb6c86d553ab74b74d8c9bcdf4c2fc989f349b7a52fa9f5af7f**；asar **6e738993fa2aebdcbd0cdc39625792b0c1e1bcc88c26ecdbbe77e5fe9fcc07ba**；实测 NotSigned。本机同一安装包 + 真实 providers 复测：真实模型回答“现在是 2026 年 10 月 17 日周六，晚上 22:35”，工具结果含 `timeZone/Asia/Shanghai` 与 `local`；空闲触发 `memory/operation extract source=real` 状态 **success**（此前为 connection-failed）。源码 efafe5d 的本地类型／lint、74 文件／514 单测与 build 通过。

23:10 发布：该安装器已上传 GitHub Release **v0.1.0**（tag `v0.1.0`，`https://github.com/3067997259-design/love-college-agent/releases/tag/v0.1.0`）；GitHub 记录的资产 sha256 与上面的本地 SHA-256 一致。仓库当前 private，按计划代码冻结后转 public。

23:53 真实 IMAP 版完整通过：源码 **4392b498bd6a3d3196a42a120d6e70ceca6b9a20**、trackedDirty=false；相对 efafe5d 增加只读真实 IMAP source（ImapFlow + mailparser，只读“桃子”文件夹、不写已读、不写邮箱；附件进入隔离资料处理）以及真实邮件标题概括回退和 `YYYY/MM/DD HH:MM` 日期格式兼容。整轮 **26/26** 安装场景通过（报告 ok=true）。安装器 **264,344,481 字节**，SHA-256 **770554c225c426da7632dc8e421c82f39d4f59cff2d30bc8d411758529499710**；asar **d0eb5ac0136765098c7ffe213611aaea8efb4faa71183143612c61da5b52e884**；实测 NotSigned。真实 providers + 真实邮箱在本机走通：`unseenCount=1 → privacy → 候选“提交SI400作业1”（截止 2026-10-18 14:00）→ 实际 .ics + .md 交付 → 真实模型看到交付 → 休息给羽毛笔 given`；导出 `demo-mail.lca-save`（474,880 字节，SHA-256 `2a1ab072affc80710f438d83b09184e6f9f92097f2e1153aa3caa3a23267f928`），新 profile 恢复验证 2 消息/2 交付/羽毛笔 given/backup restored。安装版复扫同一邮箱：`source=real/ready`，候选 confirmed，2 份交付，quill given。源码 4392b49 的本地类型／lint、75 文件／520 单测与 build 通过。发布 Release **v0.1.1**（tag `v0.1.1`）。

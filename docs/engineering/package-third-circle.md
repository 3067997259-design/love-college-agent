# 第三圈安装态收口

`pnpm package:win` 构建当前 Windows NSIS 包，临时目录、electron-builder 和 Electron 缓存沿用 D 盘。`release/build-receipt.json` 绑定实际 Git revision、已跟踪改动标记、安装器和 app.asar SHA-256；构建途中源码改变则拒绝生成回执。回执、包及 test-results 为本机产物，不进入源码提交。

`pnpm test:package` 先核对回执哈希、包内凭据／本地数据排除和解包的 SQLite 原生模块，再做解包版／真实安装版原生探针、普通 profile 重启和历史照片／引用。随后用同一个实际安装 EXE 顺序运行 onboarding、life-work、sleep、flow-drafts、desk-shadow、delegates、optical、minecraft、voice、computer、web-fetch、booth、mini 和 showcase，共 14 项原生场景。模型／服务为自有合成 HTTP 或 fake，不消耗真实生成额度，也不把通过这些测试当真实模型质量验收。

测试安装目录是 D 盘独立 GUID 目录，预先核对绝对路径归属；已有同名用户安装时拒绝升级／卸载。测试结束只调用自己本轮安装目录的卸载器。各场景使用独立 profile，未加载用户凭据或正常书本；不得为绕过检查删除用户的安装记录。

2026-10-17 07:08 实测通过：七类探针分别跑解包版与安装版、普通界面重启、完整历史照片／引用／私人恢复，以及上述 14 项安装版原生场景，最终 `ok=true`。测试安装已卸载。源码回执 `4a34e4d4707e5860ec3ac9fe22d1c94c7079424a`，trackedDirty=false，该 SHA 的 CI 也已通过。安装器 238117049 字节，SHA-256 `19aa25342010e4b1899fa9325092868751ecc6f302f6b54be3ce5f47a12465bc`；实际 Authenticode 状态 NotSigned。此包替代 06:58 的 47c0981 测试包。

本机安装器：`D:/lca-gpt/release/Love-College-Agent-0.1.0-Setup.exe`；构建回执 `release/build-receipt.json`，验收报告 `test-results/package-report.json`。main checkout 的 release 不会随 Git 合并更新。前 13 个场景按独立 profile 顺序跑，showcase 是同一书本的跨功能连续链路。两者仍不是五分钟路演观感、真实供应商质量或长期自主运行的证明。

# 第三圈安装态收口

`pnpm package:win` 构建当前 Windows NSIS 包，临时目录、electron-builder 和 Electron 缓存沿用 D 盘。`release/build-receipt.json` 绑定实际 Git revision、已跟踪改动标记、安装器和 app.asar SHA-256；构建途中源码改变则拒绝生成回执。回执、包及 test-results 为本机产物，不进入源码提交。

`pnpm test:package` 先核对回执哈希、包内凭据／本地数据排除和解包的 SQLite 原生模块，再做解包版／真实安装版原生探针、普通 profile 重启和历史照片／引用。随后用同一个实际安装 EXE 顺序运行 onboarding、life-work、sleep、flow-drafts、desk-shadow、delegates、optical、minecraft、voice、computer、web-fetch、booth 和 mini，共 13 项原生场景。模型／服务为自有合成 HTTP 或 fake，不消耗真实生成额度，也不把通过这些测试当真实模型质量验收。

测试安装目录是 D 盘独立 GUID 目录，预先核对绝对路径归属；已有同名用户安装时拒绝升级／卸载。测试结束只调用自己本轮安装目录的卸载器。各场景使用独立 profile，未加载用户凭据或正常书本；不得为绕过检查删除用户的安装记录。

本项运行结果及安装器实际 SHA 待构建完成后追加；此段仅说明已实现的可复现流程。

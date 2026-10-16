# Windows 安装包验收

## 当前第一圈包

2026-10-16 **22:47:53 GMT+8** 完成验收。包含 main `364028e` 的全部功能代码，之后仅维护文档。产物 `D:\lca-gpt\release\Love-College-Agent-0.1.0-Setup.exe`，**235,230,435 字节**，SHA-256：

```text
679fb8f2b2581e8ef73e663566088d87a7f231d8eb70d2d2660e25d88bfd4c10
```

`pnpm package:win` 与 `pnpm test:package` 通过：ASAR 白名单／原生模块解包检查；解包目录和实际 NSIS 安装后的 SQLite、日志、番茄钟、私人存档四组探针；安装版界面和重启保留会话。每个探针独立数据目录，不读真实 providers。测试安装到 D 盘唯一目录，测试实例已卸载，用户数据没有被清空。另实际检查 Authenticode，状态 `NotSigned`；builder 的 signtool 提示不代表有效签名。

本包包含第一圈主进程、正常模式模型配置入口、Claude 迷你窗与晕染、原生双窗口。源码相关流程还通过 119 项单测和 Electron 测试，详见 [第一圈记录](first-circle-closeout.md)。这不是另一台干净机器验收，未验证真实 IMAP／学校隐私模型／Rodin。文件名仍为 0.1.0，请用上述 SHA 区分旧包；未发布或上传安装包。

## 第零圈包历史

2026-10-16 19:12:09 GMT+8，包含 `491f1cd` 的全部功能代码（之后仅文档提交）。当前 `release/Love-College-Agent-0.1.0-Setup.exe` 为 223,974,573 字节，SHA-256：

```text
425fed71b3294a6296544c1048ab8f89a6576b5824e9baae90987b516cd0984a
```

ASAR 白名单与原生模块解包检查通过；构建目录和 NSIS 实际安装后均通过 SQLite、日志、跨 4 点计时重启探针；安装后的界面重启保留会话。测试实例已卸载，调试测试端口已关闭。Windows `Get-AuthenticodeSignature` 返回 `NotSigned`。本地报告已更新到这一包；路径与首包相同，下面首包哈希仅作历史记录。

## 首包历史

2026-10-16 18:50:57 GMT+8 完成安装验收（0 h = 16:32，早于 0 h + 6 的 22:32）。

- `pnpm package:win`：electron-builder 26.15.3，Electron 44.7.2，Windows x64 NSIS；使用本机已经安装的 Electron 分发文件，缓存、临时文件放 D 盘。先显式 `pnpm rebuild:native`，构建配置不再次隐式重编译。
- `pnpm test:package`：检查 ASAR 文件清单和原生解包路径；运行构建目录的 SQLite/日志探针；NSIS 静默安装到 D 盘唯一测试目录，再运行相同探针、真实界面和重启检查；最后调用该目录的卸载程序。发现已有同名用户安装时拒绝测试，避免覆盖或卸载它。
- 打包白名单仅应用 `out/`、package 和生产依赖；不包含 `secrets/`、本机运行数据或参考材料。运行时数据在用户数据目录，开发通过 `LCA_DATA_DIR` 隔离，不向安装目录写存档。

首包 `release/Love-College-Agent-0.1.0-Setup.exe`，223,969,341 字节，SHA-256：

```text
f415f85a043401b6bf7eee125fba13df9df79726fdeed105cd9c2a266a6246fb
```

首包基于开发模式合并后的底座，尚不含随后补齐的番茄钟；完成第零圈后另打最终验收包。安装包未签名，默认 Electron 图标，尚无自动更新／发布；builder 的签名步骤提示不等于有有效签名。better-sqlite3 13 的本机重编译结果位于 `prebuilds/win32-x64.node`，随包在 ASAR 外，已实际加载验证（ABI 149）。

验收期间修正了脚本的两个路径假设：Windows ASAR 列表返回反斜杠，且新版本原生模块路径不是旧版 `build/Release/better_sqlite3.node`。同时将 UI 定位限定到有姿势标记的主舞台，避免和门牌元素重复匹配。

本地详细报告与安装后截图在 `test-results/package-report.json`、`test-results/installed.png`，均不提交。使用 Playwright 检查的实例明确指定不存在的测试供应商文件，没有加载真实凭据。

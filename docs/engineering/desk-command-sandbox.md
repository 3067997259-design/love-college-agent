# Windows 命令隔离底座

2026-10-17。用户已选“仅书桌、运行命令逐次审批，展位禁用”。当前已提供独立原生执行器、可信副本／端口及真实系统探针，**尚未给应用开放 `run_command` 或 shell 入口**；原有 `run_javascript` 仍是 Chromium worker，不冒充终端。共享接口 `2f96cc6` 已先合 main（6a9448b），审批与受版本保护的写回仍待接线。

## 已验证的实现

`native/desk-command/DeskCommand.cs` 是依据公开 Win32 API 独立实现的 C# helper，使用本机 .NET Framework 编译器构建，不安装依赖或浏览器。`scripts/build-desk-command.mjs` 输出 `out/native/DeskCommand.exe` 和源文件／可执行文件 SHA-256 收据；打包集成仍未完成。

- 每次创建唯一 AppContainer profile，不授予网络 capability。只对主进程准备的一次性副本授予该 SID 的 Modify 及低完整性标签；不改真实书桌、私人 profile、系统或祖先目录的 ACL。副本中给当前宿主用户 FullControl 是降低标签所需的 WRITE_OWNER；受限进程仅获 Modify。
- 通过 `SECURITY_CAPABILITIES` 启动挂起进程，查询 token 确认确为 AppContainer，加入 kill-on-close Job Object 后才恢复。Job 最多八个进程、512 MiB，限制剪贴板、窗口句柄等 UI 权利；不允许 breakaway。无隔离失败后的普通进程回退。
- 仅继承三个显式 stdio 句柄；环境从系统／临时路径白名单构造，没有宿主模型、邮箱、代理变量。系统运行时和该 AppContainer 自己的存储属于 OS 的运行资源，不把 cwd 当成文件安全边界。
- 命令后端使用系统 `cmd.exe /d /q /s /c`，关闭 AutoRun。命令单行最多 6000 UTF-16 字符，时间 500–30000 ms，stdout＋stderr 共 65536 bytes。helper 的输入／JSON 控制协议及子程序输出都采用严格 UTF-8，不按 OEM 猜测或替换字节；无效输出明确失败且不写回。非 UTF-8 OEM 系统的非 ASCII 命令字面量在任何执行前拒绝，报 command-encoding-unsupported。Unicode 文件／输出可用 ASCII 的 PowerShell -EncodedCommand 和显式 UTF-8 文件／原始输出流；`LCA_DESK_ROOT` 只指向本次隔离副本。
- 正常结束、超时、取消、超量均终止 Job 全树。宿主断开 stdin 会取消；helper 被强杀时 OS 关闭 Job 句柄，子孙进程也结束。正常路径删除自己的 AppContainer profile；可信父进程可用提前收到的 profile 控制帧在强杀后调用 `--cleanup`。不得从工作副本里的可改文件读取清理目标。
- helper 的控制流 stdout 只有 JSON 控制帧和结果；不直接透传进程字节，错误仅阶段／固定代码。标准输出／错误正文属于之后的工作专用输出，尚未送到模型、快照或业务日志。

## 实际试错与验收

最初 PowerShell 原型：直接定位 D 盘路径被 provider 拒绝；为受限路径建 PSDrive 后，基本脚本可执行，但 `& cmd.exe` 静默不执行。`.NET Process.Start` 可以派生原生进程，这仍不足以报告为可用终端，因此不把该原型接进产品。改为 `cmd.exe` 后标准命令和子命令真实运行；探针仍用嵌套 PowerShell/.NET 执行负面系统检查。

`pnpm probe:desk-command:runtime` 实际通过：

1. 真实低权限命令在副本落下 `result.txt`，原生子命令成功；PowerShell 显式 UTF-8 的中文文件和 stdout 成功。
2. 书桌外的合成 canary 读、写及重设 ACL 均失败，原字节保留；零网络 capability 的受限进程未连到本机监听器，监听器收到零连接。此项证明当前机器边界，不是对任意系统配置的渗透测试。
3. 宿主凭据／代理类环境计数为零；输出超限、真实墙钟超时和 stdin 取消分别给出正确状态。
4. 实际创建一个长运行子孙进程，确认 PID 存活后强杀 helper，随后确认该 PID 已不存在，并通过 helper 清理该次 profile。

该探针不读取真实凭据，不操作参考实例，所有被写入／拒绝的资料都在自己新建的测试目录。它还不能证明应用审批、写回、私人恢复或安装版行为，这些仍是下一步的明确缺口。

09:34：增加主进程端口和副本模块。端口核对编译收据的 exe SHA-256，使用白名单宿主环境、UTF-8 增量解码和 500 kB 控制协议上限；超时／取消等待真实进程结束，必要时强杀并通过可信 profile 控制帧清理。`probe-command-process.mjs` 实际通过编译收据、中文输入／输出协议、真实写文件及父信号取消。

副本只接受完整受限文字项目：300 文件、每份 64 kB、深八层、最多 1000 条目录项；坏 Unicode、NUL、二进制、链接、硬链接或不支持的路径均拒绝，不静默遗漏。准备后重新核对副本及原项目哈希；程序改写副本，计算 add/edit/delete，暂不改变真实书桌。仅保留的 `.lca-runtime` 目录不计作作品；清理先验证自己唯一副本的绝对路径和真实路径。7 项单测通过（冻结、增删改、坏文件／硬链接、保留目录及清理边界）；实际文件写回尚未接通。

09:47 CI 增补：Windows runner 的系统代码页不同，旧 helper 默认控制流解码及 `chcp 65001` 假设不成立，出现问号和 Access denied。已固定 helper stdin/stdout UTF-8，移除沙箱内改控制台代码页的要求，以显式 UTF-8 的子程序字节验证 Unicode；没有放开 AppContainer、UI Job 或文件权限。Windows 8.3 临时目录别名已在 949db62 修为规范路径锚定；普通文件／符号链接和硬链接守卫保留，新增大小写别名回归。

09:58 CI 探针增补：文件／ACL 与网络负面探针拆开；ACL 直接构造 SecurityIdentifier 而非通过账户名做 LSA 翻译，并写下调用前标记，证明真正到达 SetAccessControl。环境检查直接调用 .NET，减少 PowerShell provider／模块初始化。网络探针也须有实际尝试标记，核对零 capability、监听器零连接及无逃逸输出；若网络栈被 OS 卡住，则接受监督器超时作为“未连接且已终止”的证据，不将它当作网络操作完成。

10:06 #31：编码接口 fd884da 先合 main。原始中文复合命令及中文重定向文件回归保留：支持 UTF-8 的机器必须逐字正确，其他 OEM 系统必须在任何前置写文件前明确拒绝。另有任意非法 UTF-8 字节（0xff）输出必须被拒的独立回归，不能因进程退出码零就返回 completed。显式 UTF-8 的中文脚本／文件和后续全套隔离探针仍须实际通过；不以删除原始回归或猜测编码消除 CI 失败。

## API 来源

参考的是机制和公开参数，无整段拷贝参考项目代码：[Microsoft 启动 AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)、[隔离资源边界](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[进程属性 API](https://learn.microsoft.com/en-us/windows/desktop/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)、[Job Object 生命周期](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。

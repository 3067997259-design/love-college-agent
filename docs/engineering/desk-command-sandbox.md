# Windows 命令隔离底座

2026-10-17。用户已选“仅书桌、运行命令逐次审批，展位禁用”。本提交只提供独立原生执行器及真实系统探针，**尚未给应用开放 `run_command` 或 shell 入口**；原有 `run_javascript` 仍是 Chromium worker，不冒充终端。共享接口、审批、可信工作副本和受版本保护的写回是后续实现。

## 已验证的实现

`native/desk-command/DeskCommand.cs` 是依据公开 Win32 API 独立实现的 C# helper，使用本机 .NET Framework 编译器构建，不安装依赖或浏览器。`scripts/build-desk-command.mjs` 输出 `out/native/DeskCommand.exe` 和源文件／可执行文件 SHA-256 收据；打包集成仍未完成。

- 每次创建唯一 AppContainer profile，不授予网络 capability。只对主进程准备的一次性副本授予该 SID 的 Modify 及低完整性标签；不改真实书桌、私人 profile、系统或祖先目录的 ACL。副本中给当前宿主用户 FullControl 是降低标签所需的 WRITE_OWNER；受限进程仅获 Modify。
- 通过 `SECURITY_CAPABILITIES` 启动挂起进程，查询 token 确认确为 AppContainer，加入 kill-on-close Job Object 后才恢复。Job 最多八个进程、512 MiB，限制剪贴板、窗口句柄等 UI 权利；不允许 breakaway。无隔离失败后的普通进程回退。
- 仅继承三个显式 stdio 句柄；环境从系统／临时路径白名单构造，没有宿主模型、邮箱、代理变量。系统运行时和该 AppContainer 自己的存储属于 OS 的运行资源，不把 cwd 当成文件安全边界。
- 命令后端使用系统 `cmd.exe /d /q /s /c`，关闭 AutoRun，先设代码页 65001。命令单行最多 6000 UTF-16 字符，时间 500–30000 ms，stdout＋stderr 共 65536 bytes。中文内建输出和原生子程序已实测；自行改代码页的程序仍可能改变输出编码。
- 正常结束、超时、取消、超量均终止 Job 全树。宿主断开 stdin 会取消；helper 被强杀时 OS 关闭 Job 句柄，子孙进程也结束。正常路径删除自己的 AppContainer profile；可信父进程可用提前收到的 profile 控制帧在强杀后调用 `--cleanup`。不得从工作副本里的可改文件读取清理目标。
- helper 的控制流 stdout 只有 JSON 控制帧和结果；不直接透传进程字节，错误仅阶段／固定代码。标准输出／错误正文属于之后的工作专用输出，尚未送到模型、快照或业务日志。

## 实际试错与验收

最初 PowerShell 原型：直接定位 D 盘路径被 provider 拒绝；为受限路径建 PSDrive 后，基本脚本可执行，但 `& cmd.exe` 静默不执行。`.NET Process.Start` 可以派生原生进程，这仍不足以报告为可用终端，因此不把该原型接进产品。改为 `cmd.exe` 后标准命令和子命令真实运行；探针仍用嵌套 PowerShell/.NET 执行负面系统检查。

`pnpm probe:desk-command:runtime` 实际通过：

1. 真实低权限命令在副本落下 `result.txt`，中文 stdout 和原生子命令成功。
2. 书桌外的合成 canary 读、写及重设 ACL 均失败，原字节保留；零网络 capability 的受限进程未连到本机监听器，监听器收到零连接。此项证明当前机器边界，不是对任意系统配置的渗透测试。
3. 宿主凭据／代理类环境计数为零；输出超限、真实墙钟超时和 stdin 取消分别给出正确状态。
4. 实际创建一个长运行子孙进程，确认 PID 存活后强杀 helper，随后确认该 PID 已不存在，并通过 helper 清理该次 profile。

该探针不读取真实凭据，不操作参考实例，所有被写入／拒绝的资料都在自己新建的测试目录。它还不能证明应用审批、写回、私人恢复或安装版行为，这些仍是下一步的明确缺口。

## API 来源

参考的是机制和公开参数，无整段拷贝参考项目代码：[Microsoft 启动 AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)、[隔离资源边界](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[进程属性 API](https://learn.microsoft.com/en-us/windows/desktop/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)、[Job Object 生命周期](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。

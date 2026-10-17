# Windows 书桌命令

2026-10-17。用户已选“仅书桌、运行命令逐次审批，展位禁用”。`run_command` 已接入心流和朴素书页审批；原有 `run_javascript` 仍是独立 Chromium worker。共享接口 `2f96cc6` 已先合 main（6a9448b），编码失败码接口 fd884da 也已先合 main。以下区分真实命令执行、文件写回和安装态；当前旧 NSIS 仍未收录本批代码。

## 已验证的实现

`native/desk-command/DeskCommand.cs` 是依据公开 Win32 API 独立实现的 C# helper，使用本机 .NET Framework 编译器构建，不安装依赖或浏览器。`scripts/build-desk-command.mjs` 输出 `out/native/DeskCommand.exe` 和源文件／可执行文件 SHA-256 收据；build/dev/start/package 均接入编译，asarUnpack 包含 helper 和收据。配置存在不等于安装验收通过，新包留到本轮收口。

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

## 应用接线与实际验收

- 仅心流执行模式开放 `run_command`。书本 `flow.command.run` 只准备副本；显示完整命令、时限、文件数与输入指纹，逐次 `approve` 才执行。常见 PowerShell EncodedCommand 提供只读解码预览并转义控制字符；主进程也检查解码源中的已知凭据，渲染层不参与执行决策。
- 执行前核对真实书桌及副本的内容指纹。程序只改副本；退出码零、进程树结束、输出是严格 UTF-8 且全部输出文件符合文本项目约定后，再检查所有目标的真实版本。先整体预检，再逐个用既有 desk/change → 实际写文件 → desk/settled 和 Git 影子收据落盘。每个写入间让出事件循环，停止／熄灯可以中断后续写回。
- publication=applied／unchanged 才表示写回成功。预检冲突不动真实书桌；写入过程中失败／取消标 partial，appliedFiles 只计已核实写回，包含零个已核实文件但存在未确认写入的情况。跨文件并非操作系统事务，不称作原子写回。命令产生的非文件副作用只在隔离进程／副本内，不能凭退出码说任务整体完成。
- 快照和命令元日志没有 stdout/stderr；输出只进工作工具结果和用户专用预览，不进普通记忆。各输出最多保留 16000 UTF-16 单元，截断带标记并避免切坏代理对，模型另有 outputTruncated。退出心流只接回请求数、进程／写回历史收据和文件证据，不接回源文件或输出正文。
- 新用户工作、目标变化、停止、熄灯、插件关闭及关闭应用会取消等待／运行；正在进行的模型回合先停止，再退出心流。等待中的旧批准不因重启、导入存档而执行。书本之外拒绝命令审批；展位模式实际拒绝。专注／安静时人工审批沿用现有的唯一 flow-approval 通知种类，不新增普通工作通知。
- .NET Framework／系统 shell 的 MAX_PATH 在真实 Electron profile 深路径中被复现（HRESULT 0x800700CE），故临时副本使用临时目录所在盘的 `.lca-cmd/<scope-hash>/lca-command-UUID` 短目录。按现有上限，77 字符副本根＋180 字符相对路径低于 260；真实书桌不搬动，清理仍只删自身已验证的副本。空目录和运行缓存不是持久文件产物。

`pnpm test:desk-command` 已通过：真实 Electron/SQLite、fake 模型请求到真实 cmd、书页人工批准、两个实际产物和日志关联、独立输出窗口／无 bridge、拒绝、输入冲突前不执行、非零退出不写回、真实非法编码失败及 UI 提示、编码脚本解码预览、运行取消、父任务停止、重启不重放、普通上下文排除、实际私人存档恢复及展位禁用。合成的是任务／输入和模型，命令／隔离／磁盘／SQLite 真实运行；没有实际供应商调用，也没有操作参考服务。

类型／lint、67 文件／454 项全量 Vitest 已通过（含副本改写拒绝与输出截断回归）。原生基础和进程端口探针全套在本机通过；远端 CI 的进程退出用例已改为让真正的 PowerShell 子进程直接记录自己的 PID，避开不相关的 Process.Start/模块初始化路径。远端通过与否另查 Actions，不以本机结果替代。原有心流、问答、睡眠准备竞态及工作草稿原生流程也已通过；新包、连续演示、真实模型选择命令的质量仍待验收。

远端复核：main `de547a0` 的 [Windows CI 38994010512](https://github.com/3067997259-design/love-college-agent/actions/runs/38994010512) 全部成功。436 项当时已提交的单测通过；原生完整链实际报告 unicodeLiteral=rejected-before-effects、显式 UTF-8 中文输出／文件、非法字节拒绝、外部文件／ACL／网络拒绝、上限、超时、取消及 helper 强杀后子进程退出；随后真实进程端口也成功。该 CI 证明已提交底座；本批应用接线的 454 项为本机检查，合入后另看新 CI。

## API 来源

参考的是机制和公开参数，无整段拷贝参考项目代码：[Microsoft 启动 AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)、[隔离资源边界](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[进程属性 API](https://learn.microsoft.com/en-us/windows/desktop/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)、[Job Object 生命周期](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。

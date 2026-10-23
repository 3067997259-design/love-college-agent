import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import JSZip from 'jszip'

const root = resolve(import.meta.dirname, '..')
const release = resolve(process.env.LCA_RELEASE_DIR ?? join(root, 'release'))
const receipt = JSON.parse(await readFile(join(release, 'build-receipt.json'), 'utf8'))
assert.equal(receipt.trackedDirty, false, 'Bundle requires committed build sources')
assert.match(receipt.appVersion, /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/)
assert.equal(receipt.installerFileName, `Love-College-Agent-${receipt.appVersion}-Setup.exe`)
assert.ok(process.env.LCA_BASELINE_INSTALLER, 'Supply the verified 1.1.0 installer path')
assert.ok(process.env.LCA_OFFLINE_DIR, 'Supply a new offline bundle directory')
const output = resolve(process.env.LCA_OFFLINE_DIR)
await mkdir(output, { recursive: true }); assert.equal((await readdir(output)).length, 0, 'Refuse to overwrite an existing bundle')
async function sha(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
const baseline = { appVersion: '1.1.0', file: 'Love-College-Agent-1.1.0-Setup.exe', bytes: 295012176, sha256: 'e6b23c25afbd329d880302f0d15f6c7388f9366097e813cd214b5a0cd5c9b403', asarSha256: '2c3ed89000861c490414efd6839feb856e153aab453a60b24ac82c06f32709a9' }
assert.equal(await sha(process.env.LCA_BASELINE_INSTALLER), baseline.sha256)
assert.equal((await stat(process.env.LCA_BASELINE_INSTALLER)).size, baseline.bytes)
assert.equal(await sha(join(release, receipt.installerFileName)), receipt.installerSha256)
const candidate = { appVersion: receipt.appVersion, file: receipt.installerFileName, bytes: (await stat(join(release, receipt.installerFileName))).size, sha256: receipt.installerSha256, asarSha256: receipt.asarSha256, sourceRevision: receipt.sourceRevision }
for (const [from, to] of [[process.env.LCA_BASELINE_INSTALLER, baseline.file], [join(release, receipt.installerFileName), candidate.file], [join(release, 'build-receipt.json'), 'build-receipt.json'], [join(root, 'scripts/offline-acceptance.ps1'), 'Run-Acceptance.ps1']]) await copyFile(from, join(output, to))
await writeFile(join(output, 'README.txt'), `LCA ${candidate.appVersion} 第二台 Windows 离线验收

这是功能候选包，全房间美术尚未制作，并非正式 1.2 发布。
源码：${candidate.sourceRevision}
新安装器 SHA-256：${candidate.sha256}
旧版 1.1.0 SHA-256：${baseline.sha256}

把整个 ZIP 解压到可写且不含英文逗号和 & 的目录，例如 C:\\LCA-Test。
不需要 Node、pnpm、开发仓库或网络；可以断网完成。无需配置模型、邮箱或学校服务。
所有检查使用全新隔离数据，自动化结束后只卸载自己创建的测试安装；原始测试数据留在本机。
若已有 Love College Agent 安装，脚本会拒绝，不要卸载日用实例来绕过它。请用另一 Windows 用户或干净机器。
如果机器限制未签名 EXE/PowerShell，请记录提示并回传，不要关闭系统安全设置。

在解压目录右键“在终端中打开”，按顺序执行：
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\Run-Acceptance.ps1 -Mode Check
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\Run-Acceptance.ps1 -Mode Fresh
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\Run-Acceptance.ps1 -Mode Upgrade
ExecutionPolicy Bypass 只用于这次脚本进程，不修改机器策略；脚本/安装器会先核对清单哈希。
默认工作目录在本机 LocalAppData\\LCA-Acceptance；如路径含逗号/&，加 -WorkRoot C:\\LCA-Test-Runs（须可写）。

Fresh 会安装候选版、执行 6 个包内探针，然后打开书两次：
1. 完成新手初始化，选安静模式，翻看设置、扩展和协作入口，检查文字、按钮和审批区域没有不可操作的遮挡。
2. 在没有模型配置时发一句“OFFLINE_FRESH_NOTE”，应有明确未配置/失败反馈，不能伪装模型已回答。
3. 完全关闭书（系统托盘也退出）。第二次启动应仍是安静模式，并保留这句用户记录。

Upgrade 会先安装包内的原版 1.1.0，再以同一路径真实升级到候选版：
1. 旧版书打开后完成初始化，选安静模式，发送“OFFLINE_UPGRADE_NOTE”，不需要模型回复。
2. 选一个新建的空项目文件夹。可在设置中导出一份私人存档到本机，保留它即可，不要回传存档。
3. 完全关闭旧版，脚本安装候选版。检查新手流程没有重来，安静模式、用户记录、选中项目仍在。
4. 再次关闭并冷启，核对以上状态。扩展/协作页可打开，无模型时不会自动创建成员或声称完成工作。

每次脚本最后询问人工检查是否通过：Y=通过，N=失败，U=不确定。
终端会显示 RESULT: ...\\return-results.zip。请把 Fresh 和 Upgrade 两个结果 ZIP 回传，并注明目视问题。
结果只含版本、哈希、Windows 版本和预定义探针回执；不含机器名、账号、凭据、原始日志或私人存档。
若失败也会留下结果；安装状态未知时先回传，不要连续重试安装。脚本不会自动清除测试资料。
脚本通过只证明离线安装/包内检查；真实模型选择质量、第二机结果审核及长期使用单独记录。
`, 'utf8')
const files = []
for (const file of await readdir(output)) files.push({ file, bytes: (await stat(join(output, file))).size, sha256: await sha(join(output, file)) })
await writeFile(join(output, 'manifest.json'), JSON.stringify({ schema: 1, candidate, baseline, files }, null, 2))
const zipPath = output + '.zip', zip = new JSZip()
for (const file of await readdir(output)) zip.file(`${basename(output)}/${file}`, createReadStream(join(output, file)))
await pipeline(zip.generateNodeStream({ streamFiles: true, compression: 'STORE' }), createWriteStream(zipPath, { flags: 'wx' }))
const report = { bundle: zipPath, bytes: (await stat(zipPath)).size, sha256: await sha(zipPath), candidate, baseline, secondMachineAccepted: false }
await writeFile(output + '-receipt.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))

import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile, stat, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import { runtimeEnv, initializeTestBook } from '../scripts/runtime-env.mjs'

const root = resolve(import.meta.dirname, '..'), release = resolve(process.env.LCA_RELEASE_DIR)
const receipt = JSON.parse(await readFile(join(release, 'build-receipt.json'), 'utf8'))
const baseInstaller = process.env.LCA_BASELINE_INSTALLER
const hash = async (p) => createHash('sha256').update(await readFile(p)).digest('hex')
assert.equal(await hash(baseInstaller), 'e6b23c25afbd329d880302f0d15f6c7388f9366097e813cd214b5a0cd5c9b403')
assert.equal(receipt.trackedDirty, false)
assert.equal(await hash(join(release, receipt.installerFileName)), receipt.installerSha256)
const id = randomUUID(), folder = join('C:/', '.lca-cache', 'upgrade-tests', id), install = join(folder, 'installed'), data = join(folder, 'book'), project = join(folder, 'project')
const evidence = join(root, 'test-results', 'p6-upgrade-' + id), archive = join(folder, 'from-1.1.0.lca-save'), user = join(folder, 'user')
for (const p of [evidence, data, project, user, join(user, 'Documents'), join(user, 'AppData/Roaming'), join(user, 'AppData/Local'), join(folder, 'tmp')]) await mkdir(p, { recursive: true })
let requests = 0
const server = createServer((request, response) => { void (async () => { for await (const chunk of request) { void chunk }; requests++; response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Synthetic upgrade reply.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n') })().catch(() => response.end()) })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const providers = join(folder, 'synthetic-providers.json')
await writeFile(providers, JSON.stringify({ providers: { chat: { base_url: 'http://127.0.0.1:' + server.address().port + '/v1', api_key: 'synthetic-upgrade-key', model: 'synthetic-upgrade-model' } } }))
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: providers, LCA_MCP_PORT: '0', LCA_CDP_PORT: '0', TEMP: join(folder, 'tmp'), TMP: join(folder, 'tmp'), HOME: user, USERPROFILE: user, APPDATA: join(user, 'AppData/Roaming'), LOCALAPPDATA: join(user, 'AppData/Local') }
delete env.LCA_REAL_MODEL; delete env.LCA_BOOTH; delete env.ELECTRON_RENDERER_URL
let instance, page, owned = false, stage = 'preflight'
const checks = [], report = { syntheticOnly: true, installed: false, upgraded: false, secondMachine: false, baselineVersion: '1.1.0', candidate: receipt, checks, cleanup: 'not-needed' }
function run(exe, args, timeout = 300000) { return new Promise((done, fail) => { const child = spawn(exe, args, { cwd: folder, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (x) => { output = (output + x).slice(-16384) }); child.stderr.resume(); const timer = setTimeout(() => { child.kill(); fail(new Error('PROCESS_TIMEOUT')) }, timeout); child.on('error', () => { clearTimeout(timer); fail(new Error('PROCESS_LAUNCH_FAILED')) }); child.on('exit', (code) => { clearTimeout(timer); if (code === 0) done(output); else fail(new Error('PROCESS_EXIT_' + code)) }) }) }
async function registry() { const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall') | ForEach-Object { if(Test-Path -LiteralPath $_) { Get-ChildItem -LiteralPath $_ | Get-ItemProperty | Where-Object { $_.DisplayName -like 'Love College Agent*' } | Select-Object DisplayName,DisplayIcon,UninstallString,DisplayVersion } }) | ConvertTo-Json -Compress"]); if (!output.trim()) return []; const value = JSON.parse(output); return Array.isArray(value) ? value : [value] }
async function own() { const entries = await registry(); assert.equal(entries.length, 1); assert.equal(entries[0].DisplayIcon, join(install, 'LoveCollegeAgent.exe') + ',0'); assert.ok(entries[0].UninstallString.includes(join(install, 'Uninstall LoveCollegeAgent.exe'))); return entries[0] }
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function until(test, label) { for (let i = 0; i < 600; i++) { if (await test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(label) }
async function launch() { instance = await _electron.launch({ executablePath: join(install, 'LoveCollegeAgent.exe'), args: [], cwd: folder, env, timeout: 30000 }); page = await instance.firstWindow(); await page.waitForFunction(() => !!window.lca) }
async function close() { await instance?.close(); instance = null }
async function chat(text) { const old = (await snapshot()).task?.id; assert.equal((await send({ type: 'message.send', text })).status, 'accepted'); await until((s) => s.task?.id !== old && s.task?.status === 'completed', 'CHAT_FAILED') }
const pass = (name) => { checks.push(name); console.log('UPGRADE_PASS', name) }
try {
  const disk = await statfs(folder); assert.ok(disk.bavail * disk.bsize >= 3 * 1024 ** 3, 'INSUFFICIENT_DISK_SPACE')
  assert.equal((await registry()).length, 0, 'EXISTING_INSTALLATION_REFUSED')
  const processes = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (Get-Process -Name LoveCollegeAgent -ErrorAction SilentlyContinue) { 'occupied' } else { 'free' }"])
  assert.equal(processes.trim(), 'free', 'RUNNING_APP_REFUSED_INSTALLER_CAN_CLOSE_OTHER_INSTANCES')
  stage = 'install-baseline'; report.cleanup = 'needs-reconciliation'; await run(baseInstaller, ['/S', '/currentuser', `/D=${install}`], 900000); owned = true; await own()
  assert.equal(await hash(join(install, 'resources/app.asar')), '2c3ed89000861c490414efd6839feb856e153aab453a60b24ac82c06f32709a9'); report.installed = true
  await launch(); assert.equal(await instance.evaluate(({ app }) => app.getVersion()), '1.1.0'); await initializeTestBook(page)
  assert.equal((await snapshot()).runtime.developer.mode, 'normal'); await send({ type: 'mode.set', mode: 'quiet' }); await send({ type: 'onboarding.profile', userName: 'Synthetic upgrade owner' })
  await instance.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, project)
  await send({ type: 'project.pick' }); await until((s) => s.work.current.path === project, 'PROJECT_NOT_PICKED')
  await chat('P6_OLD_VERSION_NOTE')
  await instance.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, archive)
  assert.equal((await send({ type: 'backup.export' })).status, 'accepted'); await until((s) => s.backup.status === 'exported', 'OLD_SAVE_FAILED')
  const old = await snapshot(); await close()
  // Seed a user's existing profile only after the old runtime has stopped. The upgrade must keep
  // its manifest settings and patch/workspace bytes while updating LCA's protected bridge link.
  const dshProfile = join(data, 'dsh-home', 'profiles', 'lca'), manifestPath = join(dshProfile, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.lcaUpgradeProbe = { preserve: 'synthetic-user-configuration' }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const configBefore = new Map()
  for (const name of ['cordis.patch.yml', 'pnpm-workspace.yaml']) {
    const file = join(dshProfile, name), content = '# Synthetic user setting retained across upgrade\n' + await readFile(file, 'utf8')
    await writeFile(file, content); configBefore.set(file, content)
  }
  async function profilePreserved() {
    const current = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.deepEqual(current.lcaUpgradeProbe, manifest.lcaUpgradeProbe)
    for (const [name, value] of Object.entries(manifest.dependencies ?? {})) if (name !== '@lca/dsh-bridge') assert.equal(current.dependencies[name], value)
    for (const bundle of manifest.dsh?.profile?.bundles ?? []) assert.ok(current.dsh.profile.bundles.includes(bundle))
    for (const [file, content] of configBefore) assert.equal(await readFile(file, 'utf8'), content)
  }
  const journals = join(data, 'journals'), owner = (await readdir(journals))[0], journalFile = (await readdir(join(journals, owner))).find((f) => f.endsWith('.jsonl')), journalPath = join(journals, owner, journalFile), journalBytes = await readFile(journalPath)
  pass('actual-1.1.0-installer-and-normal-book-with-synthetic-chat-project-and-save')
  stage = 'upgrade'; await own(); await run(join(release, receipt.installerFileName), ['/S', '/currentuser', `/D=${install}`], 900000); await own()
  assert.equal(await hash(join(install, 'resources/app.asar')), receipt.asarSha256); report.upgraded = true
  await launch(); assert.equal(await instance.evaluate(({ app }) => app.getVersion()), receipt.appVersion)
  const current = await snapshot(); assert.equal(current.onboarding.status, old.onboarding.status); assert.equal(current.onboarding.userName, old.onboarding.userName); assert.equal(current.companion.mode, old.companion.mode); assert.equal(current.work.current.path, old.work.current.path); assert.equal(current.scope.sessionId, old.scope.sessionId)
  assert.ok(current.messages.some((m) => m.text === 'P6_OLD_VERSION_NOTE')); assert.ok((await readFile(journalPath)).subarray(0, journalBytes.length).equals(journalBytes))
  pass('same-install-path-upgrade-preserves-onboarding-mode-project-session-and-append-only-history')
  await chat('P6_NEW_VERSION_AFTER_SAVE'); await profilePreserved(); report.profileConfigurationPreserved = true
  pass('upgraded-book-can-complete-a-new-DSH-turn-and-preserve-user-profile-configuration')
  const beforeRestart = requests; await close(); await launch(); assert.ok((await snapshot()).messages.some((m) => m.text === 'P6_NEW_VERSION_AFTER_SAVE')); await new Promise((done) => setTimeout(done, 500)); assert.equal(requests, beforeRestart)
  pass('upgraded-cold-restart-preserves-new-history-without-model-replay')
  stage = 'restore-old-save'; await instance.evaluate(({ dialog, app }, path) => { app.relaunch = () => {}; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, archive)
  await send({ type: 'backup.import' }); await until((s) => s.backup.status === 'awaiting-confirmation', 'OLD_SAVE_IMPORT_FAILED')
  const restoreId = (await snapshot()).backup.restoreId, closed = instance.waitForEvent('close'); await send({ type: 'backup.restore', restoreId }); await closed; instance = null; await launch()
  const restored = await snapshot(); assert.equal(restored.backup.status, 'restored'); assert.ok(restored.backup.safetyBackupId); assert.ok(restored.messages.some((m) => m.text === 'P6_OLD_VERSION_NOTE')); assert.ok(!restored.messages.some((m) => m.text === 'P6_NEW_VERSION_AFTER_SAVE'))
  assert.equal(requests, beforeRestart); pass('1.1.0-private-save-restores-in-candidate-with-safety-backup-and-no-replay')
  await close(); report.ok = true; report.modelRequests = requests; report.archiveBytes = (await stat(archive)).size
} catch (error) { report.ok = false; report.failedStage = stage; report.error = error.message; throw error }
finally {
  await close().catch(() => {}); await new Promise((done) => server.close(done))
  if (owned) { try { await own(); const name = (await readdir(install)).find((f) => /^Uninstall .+\.exe$/i.test(f)); assert.ok(name); await run(join(install, name), ['/S', '/currentuser']);
    for (let i = 0; i < 30 && (await registry()).length; i++) await new Promise((done) => setTimeout(done, 250))
    assert.equal((await registry()).length, 0); report.cleanup = 'owned-test-install-uninstalled'
  } catch (error) { report.ok = false; report.cleanup = 'needs-reconciliation'; report.cleanupError = error.code ?? 'CLEANUP_FAILED'; process.exitCode = 1 } }
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2)); console.log('UPGRADE_EVIDENCE', evidence)
}

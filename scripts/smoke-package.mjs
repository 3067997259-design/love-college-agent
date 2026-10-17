import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const release = join(root, 'release')
const installer = join(release, 'Love-College-Agent-0.1.0-Setup.exe')
const buildReceipt = JSON.parse(await readFile(join(release, 'build-receipt.json'), 'utf8'))
assert.equal(buildReceipt.version, 1); assert.match(buildReceipt.sourceRevision, /^[a-f0-9]{40}$/)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
assert.equal(digest(await readFile(installer)), buildReceipt.installerSha256)
assert.equal(digest(await readFile(join(release, 'win-unpacked/resources/app.asar'))), buildReceipt.asarSha256)
const builderRequire = createRequire(await realpath(join(root, 'node_modules/electron-builder/package.json')))
const libRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const { listPackage } = libRequire('@electron/asar')
const files = listPackage(join(release, 'win-unpacked/resources/app.asar')).map((file) => file.replaceAll('\\', '/'))
assert.equal(files.some((file) => /(^|[/\\])(secrets|\.local-data|\.env)([/\\]|$)/i.test(file)), false)
assert.ok(files.includes('/out/main/index.cjs'))
// better-sqlite3 13 stores the @electron/rebuild output in prebuilds/win32-x64.node.
assert.ok((await stat(join(release, 'win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node'))).isFile())
const cache = process.platform === 'win32' ? 'D:\\.lca-cache\\install-tests' : join(root, '.cache/install-tests')
await mkdir(cache, { recursive: true })
const installDir = join(cache, randomUUID())
const rel = relative(resolve(cache), resolve(installDir))
assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Unsafe test installation path')
const env = { ...runtimeEnv(root), LCA_DATA_DIR: join(root, '.local-data', `package-smoke-${randomUUID()}`) }
env.LCA_PROVIDERS_FILE = join(env.LCA_DATA_DIR, 'absent-test-providers.json')
function run(exe, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, cwd: root, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] })
    let output = ''; child.stdout?.on('data', (chunk) => { output = (output + chunk.toString()).slice(-16_384) })
    const deadline = setTimeout(() => { child.kill(); reject(new Error('PACKAGE_CHECK_TIMEOUT')) }, 120_000)
    child.on('error', () => { clearTimeout(deadline); reject(new Error('PACKAGE_CHECK_LAUNCH_FAILED')) })
    child.on('exit', (code) => { clearTimeout(deadline); if (code === 0) resolve(output); else reject(new Error('PACKAGE_CHECK_FAILED: ' + (args.find((arg) => arg.endsWith('.mjs'))?.split(/[\\/]/).at(-1) ?? 'native-step'))) })
  })
}
async function probe(exe, name) {
  // Every destructive synthetic probe owns a fresh profile; none uses the UI profile or a user's data.
  env.LCA_DATA_DIR = join(root, '.local-data', `package-probe-${name}-${randomUUID()}`)
  env.LCA_PROVIDERS_FILE = join(env.LCA_DATA_DIR, 'absent-test-providers.json')
  const output = await run(exe, [`--lca-probe=${name}`], { capture: true })
  const line = output.split(/\r?\n/).find((item) => item.startsWith('LCA_PROBE:'))
  assert.ok(line); assert.equal(JSON.parse(line.slice(10)).ok, true)
}
let instance
let installed = false
try {
  if (process.platform === 'win32') {
    const occupied = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$found = Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like 'Love College Agent*' }; if ($found) { 'occupied' } else { 'free' }"], { capture: true })
    assert.equal(occupied.trim(), 'free', 'Existing user installation detected; test refuses to upgrade or uninstall it.')
  }
  const unpacked = join(release, 'win-unpacked/LoveCollegeAgent.exe')
  for (const name of ['sqlite', 'journal', 'pomodoro', 'backup', 'memory', 'life', 'heart-flow']) await probe(unpacked, name)
  await run(installer, ['/S', '/currentuser', `/D=${installDir}`]); installed = true
  const exe = join(installDir, 'LoveCollegeAgent.exe'); assert.ok((await stat(exe)).isFile())
  for (const name of ['sqlite', 'journal', 'pomodoro', 'backup', 'memory', 'life', 'heart-flow']) await probe(exe, name)
  env.LCA_DATA_DIR = join(root, '.local-data', `installed-ui-${randomUUID()}`)
  env.LCA_PROVIDERS_FILE = join(env.LCA_DATA_DIR, 'absent-test-providers.json')
  const launch = () => _electron.launch({ executablePath: exe, args: [], env, timeout: 30_000 })
  instance = await launch(); let page = await instance.firstWindow(); await initializeTestBook(page)
  await page.locator('[data-mode][data-pose][data-location]').waitFor()
  const original = await page.evaluate(() => window.lca.getSnapshot())
  assert.equal(original.runtime.developer.mode, 'normal')
  await page.evaluate(async () => { const s = await window.lca.getSnapshot(); await window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), type: 'mode.set', mode: 'quiet' }) })
  await page.locator('[data-mode="quiet"][data-pose]').waitFor(); await instance.close(); instance = await launch(); page = await instance.firstWindow(); await initializeTestBook(page)
  await page.locator('[data-mode="quiet"][data-pose]').waitFor()
  assert.equal((await page.evaluate(() => window.lca.getSnapshot())).scope.sessionId, original.scope.sessionId)
  await mkdir(join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: join(root, 'test-results/installed.png') })
  await instance.close(); instance = undefined
  env.LCA_HISTORY_EXECUTABLE = exe
  await run(process.execPath, [join(root, 'scripts/smoke-history.mjs')])
  delete env.LCA_HISTORY_EXECUTABLE
  const thirdCircleScenarios = ['onboarding', 'life-work', 'sleep', 'flow-sleep', 'flow-drafts', 'desk-shadow', 'delegates', 'optical', 'minecraft', 'minecraft-images', 'minecraft-stdio', 'minecraft-mining', 'voice', 'computer', 'web-fetch', 'booth', 'mini', 'showcase', 'life-port', 'resources', 'questions', 'desk-command', 'flow-rewind', 'settings', 'failure-narrator']
  env.LCA_TEST_EXECUTABLE = exe
  for (const name of thirdCircleScenarios) { await run(process.execPath, [join(root, 'scripts/smoke-' + name + '.mjs')]); console.log('Installed Electron scenario passed: ' + name) }
  delete env.LCA_TEST_EXECUTABLE
  const bytes = await readFile(installer)
  const report = { ok: true, atIso: new Date().toISOString(), installer, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    unsigned: true, secretsExcluded: true, nativeUnpacked: true, unpackedProbes: true, installedProbes: true, privateSaveProbe: true, installedUiRestart: true, historyQuoteAndPhoto: true, secondCircleProbes: ['memory', 'life', 'heart-flow'], buildReceipt, thirdCircleScenarios,
    syntheticServices: true, realProviderQualityAccepted: false }
  await writeFile(join(root, 'test-results/package-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await instance?.close()
  if (installed) {
    const name = (await readdir(installDir)).find((file) => /^Uninstall .+\.exe$/i.test(file))
    // Invoke only the uninstaller from this freshly created, checked test directory.
    if (name) await run(join(installDir, name), ['/S', '/currentuser'])
  }
}

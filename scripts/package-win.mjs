import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const appVersion = process.env.LCA_PACKAGE_VERSION ?? version
const reusePreparedRuntime = process.argv.includes('--reuse-prepared-runtime')
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(appVersion)) throw new Error('PACKAGE_VERSION_INVALID')
const release = resolve(process.env.LCA_RELEASE_DIR ?? join(root, 'release'))
// NSIS writes its uninstaller beside the installer; a checkout path with spaces/commas made the
// intermediate installer fail with "Error writing temporary file". Build in a short root path and
// copy the finished artifacts back to release/.
const staged = process.platform === 'win32' && !process.env.LCA_RELEASE_DIR
const output = staged ? join(root.slice(0, 3), '.lca-package') : release
const installerFileName = `Love-College-Agent-${appVersion}-Setup.exe`
const env = { ...runtimeEnv(root), CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
const revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim()
const trackedDiff = () => execFileSync('git', ['diff', 'HEAD', '--'], { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const sourceRevision = revision(); const sourceDiff = trackedDiff()
if (env.HTTP_PROXY || env.HTTPS_PROXY) env.NODE_USE_ENV_PROXY = '1'
const run = (path, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'node_modules', path), ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('PACKAGE_STEP_FAILED')))
})
try {
  if (staged) await rm(output, { recursive: true, force: true })
  // Native ABI is rebuilt explicitly with pnpm rebuild:native; packaged probes verify it again.
  // DSH runtime shipped beside the asar: pinned install from the lockfile, trimmed, with notices.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'prepare-dsh-runtime.mjs'), ...(reusePreparedRuntime ? ['--skip-install'] : [])], { cwd: root, env, stdio: 'inherit', windowsHide: true })
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('DSH_RUNTIME_FAILED')))
  })
  await run('electron-vite/bin/electron-vite.js', ['build', '--logLevel', 'warn'])
  await run('electron-builder/cli.js', ['--win', 'nsis', '--x64', '--publish', 'never', '--config', 'electron-builder.yml', `--config.directories.output=${output}`, `--config.extraMetadata.version=${appVersion}`])
  if (revision() !== sourceRevision || trackedDiff() !== sourceDiff) throw new Error('PACKAGE_SOURCE_CHANGED')
  const sha = async (path) => createHash('sha256').update(await readFile(join(output, path))).digest('hex')
  const receipt = { version: 1, appVersion, installerFileName, sourceRevision, trackedDirty: !!sourceDiff,
    runtimePreparation: reusePreparedRuntime ? 'reused-prepared-tree' : 'installed-from-lock', runtimeLockSha256: createHash('sha256').update(await readFile(join(root, 'dsh/runtime/package-lock.json'))).digest('hex'),
    builtAtIso: new Date().toISOString(), installerBytes: (await stat(join(output, installerFileName))).size, installerSha256: await sha(installerFileName),
    asarSha256: await sha('win-unpacked/resources/app.asar') }
  if (staged) {
    await mkdir(release, { recursive: true })
    for (const name of [installerFileName, `${installerFileName}.blockmap`]) if (existsSync(join(output, name))) await cp(join(output, name), join(release, name), { force: true })
    await rm(join(release, 'win-unpacked'), { recursive: true, force: true })
    await cp(join(output, 'win-unpacked'), join(release, 'win-unpacked'), { recursive: true, force: true })
  }
  await writeFile(join(release, 'build-receipt.json'), JSON.stringify(receipt, null, 2))
  if (staged) await rm(output, { recursive: true, force: true })
} catch { console.error('Windows packaging failed.'); process.exitCode = 1 }

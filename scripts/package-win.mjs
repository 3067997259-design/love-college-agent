import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeEnv } from './runtime-env.mjs'
import { buildDeskCommand } from './build-desk-command.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version: appVersion } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
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
  // Native ABI is rebuilt explicitly with pnpm rebuild:native; packaged probes verify it again.
  await run('electron-vite/bin/electron-vite.js', ['build', '--logLevel', 'warn'])
  await buildDeskCommand()
  await run('electron-builder/cli.js', ['--win', 'nsis', '--x64', '--publish', 'never', '--config', 'electron-builder.yml'])
  if (revision() !== sourceRevision || trackedDiff() !== sourceDiff) throw new Error('PACKAGE_SOURCE_CHANGED')
  const sha = async (path) => createHash('sha256').update(await readFile(join(root, path))).digest('hex')
  await writeFile(join(root, 'release/build-receipt.json'), JSON.stringify({ version: 1, appVersion, installerFileName, sourceRevision, trackedDirty: !!sourceDiff,
    builtAtIso: new Date().toISOString(), installerSha256: await sha(`release/${installerFileName}`),
    asarSha256: await sha('release/win-unpacked/resources/app.asar') }, null, 2))
} catch { console.error('Windows packaging failed.'); process.exitCode = 1 }

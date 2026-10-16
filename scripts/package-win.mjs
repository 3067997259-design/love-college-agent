import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...runtimeEnv(root), CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
if (env.HTTP_PROXY || env.HTTPS_PROXY) env.NODE_USE_ENV_PROXY = '1'
const run = (path, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'node_modules', path), ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('PACKAGE_STEP_FAILED')))
})
try {
  // Native ABI is rebuilt explicitly with pnpm rebuild:native; packaged probes verify it again.
  await run('electron-vite/bin/electron-vite.js', ['build', '--logLevel', 'warn'])
  await run('electron-builder/cli.js', ['--win', 'nsis', '--x64', '--publish', 'never', '--config', 'electron-builder.yml'])
} catch { console.error('Windows packaging failed.'); process.exitCode = 1 }

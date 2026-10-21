import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// runtimeEnv defaults to silent windows for tests; normal dev/preview must always be visible.
const env = { ...runtimeEnv(root), LCA_TEST_SILENT: process.env.LCA_TEST_SILENT ?? '0' }
const mode = process.argv[2]
const command = mode === 'rebuild' ? '@electron/rebuild/lib/cli.js' : mode === 'install-electron' ? 'electron/install.js' : 'electron-vite/bin/electron-vite.js'
const args = mode === 'rebuild' ? ['-f', '-w', 'better-sqlite3', '--build-from-source', '--jobs', '2'] : mode === 'install-electron' ? [] : [mode, ...process.argv.slice(3)]
if (mode === 'install-electron' && (env.HTTPS_PROXY || env.HTTP_PROXY)) {
  env.ELECTRON_GET_USE_PROXY = '1'
  env.GLOBAL_AGENT_HTTP_PROXY = env.HTTPS_PROXY ?? env.HTTP_PROXY
}
const child = spawn(process.execPath, [join(root, 'node_modules', command), ...args], { cwd: root, env, stdio: 'inherit' })
child.on('error', () => { console.error('Unable to start development tool.'); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })

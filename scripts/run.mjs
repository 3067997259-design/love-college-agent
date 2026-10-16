import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = runtimeEnv(root)
const mode = process.argv[2]
const command = mode === 'rebuild' ? '@electron/rebuild/lib/cli.js' : 'electron-vite/bin/electron-vite.js'
const args = mode === 'rebuild' ? ['-f', '-w', 'better-sqlite3'] : [mode, ...process.argv.slice(3)]
const child = spawn(process.execPath, [join(root, 'node_modules', command), ...args], { cwd: root, env, stdio: 'inherit' })
child.on('error', () => { console.error('Unable to start development tool.'); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })

// Real pinned DSH, production main service/host, packaged pnpm entry; no model/provider calls.
// Bundle the TS entry only for Node's test runner. All mutable state lives under the printed temp root.
import { build } from 'vite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'lca-extension-probe-'))
const entry = join(root, 'probe.mjs')
await build({ configFile: false, logLevel: 'error', build: { ssr: resolve(import.meta.dirname, 'fixtures/dsh-extension-probe.ts'), outDir: root, emptyOutDir: false, minify: false, rollupOptions: { output: { entryFileNames: 'probe.mjs' } } } })
const electron = process.argv.includes('--electron')
const executable = electron ? resolve(import.meta.dirname, '../node_modules/electron/dist/electron.exe') : process.execPath
const child = spawn(executable, [entry, root, resolve(import.meta.dirname, '..'), ...(electron ? ['--electron'] : [])], { stdio: 'inherit', windowsHide: true, env: { ...process.env, ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } })
const code = await new Promise((done) => child.once('exit', done))
writeFileSync(join(root, 'exit.json'), JSON.stringify({ code }))
process.exitCode = code ?? 1

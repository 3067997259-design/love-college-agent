import { build } from 'vite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'lca-collaboration-probe-'))
// TEMP may be on another drive, outside this checkout's node_modules ancestors.
// Resolve this fixture's external schema dependency from the owning checkout.
await build({ configFile: false, logLevel: 'error', build: { ssr: resolve(import.meta.dirname, 'fixtures/dsh-collaboration-probe.ts'), outDir: root, emptyOutDir: false, minify: false, rollupOptions: { output: { entryFileNames: 'probe.mjs', paths: { zod: import.meta.resolve('zod') } } } } })
const executable = resolve(import.meta.dirname, '../node_modules/electron/dist/electron.exe')
const child = spawn(executable, [join(root, 'probe.mjs'), root, resolve(import.meta.dirname, '..')], { stdio: 'inherit', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
const code = await new Promise((done) => child.once('exit', done))
writeFileSync(join(root, 'exit.json'), JSON.stringify({ code }))
process.exitCode = code ?? 1

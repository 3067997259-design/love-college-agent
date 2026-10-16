import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const folder = join(root, '.local-data', 'web-port-probes'); await mkdir(folder, { recursive: true }); if (await realpath(folder) !== folder) throw new Error('UNSAFE_PROBE_DIRECTORY')
const file = join(folder, randomUUID() + '.mjs'); if (!resolve(file).startsWith(folder + sep)) throw new Error('UNSAFE_PROBE_FILE')
const source = await readFile(join(root, 'src/main/web-fetch/port.ts'), 'utf8'); await writeFile(file, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText, { flag: 'wx' })
try {
  const { createPublicWebPort } = await import(pathToFileURL(file).href)
  const clock = { nowMs: () => Date.now(), after: (delay, callback) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer) } }
  const started = clock.nowMs()
  try {
    // One fixed public documentation GET, without any credential/configuration reads, proxy or retries.
    const result = await createPublicWebPort(clock).read('https://developers.openai.com/api/docs/guides/text-to-speech.md', new AbortController().signal)
    console.log(JSON.stringify({ ok: true, scope: 'production-port-transpiled-node-public-docs', elapsedMs: clock.nowMs() - started, receivedBytes: result.receivedBytes, truncated: result.truncated, contentType: result.contentType, textChars: result.text.length }))
  } catch { console.log(JSON.stringify({ ok: false, scope: 'production-port-transpiled-node-public-docs', elapsedMs: clock.nowMs() - started, error: 'web-unavailable' })); process.exitCode = 1 }
} finally { await rm(file) } // The immutable absolute file path was checked before creation.

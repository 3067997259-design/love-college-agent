import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCommandProcess } from '../src/main/desk-command/process.ts'
import { systemClock } from '../src/main/clock/index.ts'
import { buildDeskCommand } from './build-desk-command.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); await buildDeskCommand()
const port = createCommandProcess(join(root, 'out/native/DeskCommand.exe'), systemClock); assert.equal(port.available(), true)
const work = join(root, '.local-data', 'command-port-' + randomUUID(), 'lca-command-' + randomUUID()); await mkdir(work, { recursive: true })
const output = await port.run({ root: work, command: 'echo 端口中文测试>result.txt & echo PROTOCOL_OK', timeoutMs: 5000 }, new AbortController().signal)
assert.equal(output.status, 'completed'); assert.equal(output.exitCode, 0); assert.equal(output.processTreeTerminated, true); assert.ok(output.stdout.includes('PROTOCOL_OK')); assert.equal((await readFile(join(work, 'result.txt'), 'utf8')).trim(), '端口中文测试')
const abort = new AbortController(); const pending = port.run({ root: work, command: 'powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 20"', timeoutMs: 5000 }, abort.signal)
const cancel = systemClock.after(1000, () => abort.abort()); const stopped = await pending; cancel(); assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.exitCode, null)
console.log(JSON.stringify({ ok: true, probe: 'command-process-port', source: 'native', receiptVerified: true, unicodeInput: true, metadataProtocol: true, boundedOutput: true, abort: true }))

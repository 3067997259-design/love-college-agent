import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Opt-in real-provider suite. Run only after `pnpm build`.
 * It uses temporary profiles and silent windows, makes bounded requests, and records
 * booleans/counts only. Model text and credentials never enter the report.
 * The cache-usage probe additionally reports token counts from synthetic prompts.
 */
assert.equal(process.env.LCA_REAL_MODEL, '1', 'Set LCA_REAL_MODEL=1 to allow real provider requests.')
assert.ok(process.env.LCA_PROVIDERS_FILE, 'Set LCA_PROVIDERS_FILE to an authorized provider config.')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, LCA_TEST_SILENT: '1', LCA_MCP_PORT: '0', LCA_CDP_PORT: '0' }
const started = Date.now()

function run(label, script, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderrBytes = 0
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length })
    child.on('error', () => reject(new Error(label + '_SPAWN_FAILED')))
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(label + '_FAILED'))
      resolvePromise({ stdout, stderrBytes })
    })
  })
}

function probeLine(output) {
  const line = output.split(/\r?\n/).filter(Boolean).at(-1)
  assert.ok(line, 'PROBE_RESULT_MISSING')
  return JSON.parse(line.startsWith('LCA_PROBE:') ? line.slice('LCA_PROBE:'.length) : line)
}

const report = { ok: false, realModel: true, silentWindows: true, startedAtIso: new Date(started).toISOString(), probes: {} }
try {
  const model = probeLine((await run('MODEL_PROBE', join(root, 'scripts/probe-electron.mjs'), ['model'])).stdout)
  report.probes.model = { ok: model.ok === true, streamed: model.streamed === true, textPresent: model.textPresent === true, toolCalls: Number(model.toolCalls ?? 0) }
  assert.equal(report.probes.model.ok, true, 'MODEL_PROBE_NOT_OK')

  const harness = probeLine((await run('HARNESS_PROBE', join(root, 'scripts/probe-electron.mjs'), ['harness'])).stdout)
  report.probes.harness = { ok: harness.ok === true, realModel: harness.realModel === true, completed: harness.completed === true, toolVerified: harness.toolVerified === true }
  assert.equal(report.probes.harness.ok, true, 'HARNESS_PROBE_NOT_OK')

  const cache = probeLine((await run('CACHE_PROBE', join(root, 'scripts/probe-electron.mjs'), ['cache-usage'])).stdout)
  report.probes.cache = { ok: cache.ok === true, shapes: cache.shapes, pairs: cache.pairs, checks: cache.checks, journalReopened: cache.journalReopened, budget: cache.budget, failures: cache.failures }
  assert.equal(report.probes.cache.ok, true, 'CACHE_PROBE_NOT_OK')

  const ui = JSON.parse((await run('REAL_MODEL_UI', join(root, 'scripts/smoke-real-model.mjs'), [])).stdout.trim().split(/\r?\n/).at(-1))
  report.probes.ui = { ok: ui.ok === true, silentWindows: ui.silentWindows === true, assistantReply: ui.assistantReply === true, replyChars: ui.replyChars }
  assert.equal(report.probes.ui.ok, true, 'REAL_MODEL_UI_NOT_OK')

  report.ok = true
  report.durationMs = Date.now() - started
  const target = join(root, 'test-results', `real-model-report-${Date.now()}.json`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ok: true, report: target, model: report.probes.model, harness: report.probes.harness, cache: report.probes.cache.ok, ui: report.probes.ui, durationMs: report.durationMs }))
} catch (error) {
  report.error = error instanceof Error ? error.message : 'REAL_MODEL_SUITE_FAILED'
  report.durationMs = Date.now() - started
  const target = join(root, 'test-results', `real-model-report-${Date.now()}.json`)
  await mkdir(dirname(target), { recursive: true }).catch(() => {})
  await writeFile(target, JSON.stringify(report, null, 2)).catch(() => {})
  console.error(report.error)
  process.exitCode = 1
}

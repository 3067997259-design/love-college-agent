import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Clock } from '../clock'
import { openSessionStore } from '../store/session'
import { createBinaryAssets, binaryAssetSchema } from '../storage/assets'
import { createRodinApi, readRodinConfig } from '../gifts/rodin-api'
import { createRodinMcp } from '../gifts/mcp'

/** Explicit user-invoked live probe; at most three submissions across this night's probe processes. */
export async function probeRodin(root: string, credentials: string, budgetPath: string, clock: Clock) {
  const config = await readRodinConfig(credentials); if (!config) return { ok: false, probe: 'rodin', error: 'RODIN_NOT_CONFIGURED' }
  const ledger = existsSync(budgetPath) ? z.object({ submissions: z.number().int().min(0).max(3) }).parse(JSON.parse(readFileSync(budgetPath, 'utf8'))) : { submissions: 0 }
  if (ledger.submissions >= 3) return { ok: false, probe: 'rodin', error: 'RODIN_LIVE_BUDGET_EXHAUSTED' }
  const store = openSessionStore(root, { userId: 'rodin-probe', characterId: 'rodin-probe' }, clock); const assets = createBinaryAssets(root, store); const port = await createRodinMcp(createRodinApi(config, clock), assets, root)
  const id = randomUUID(); const abort = new AbortController(); const stop = clock.after(8 * 60_000, () => abort.abort()); const started = clock.nowMs()
  try {
    writeFileSync(budgetPath, JSON.stringify({ submissions: ledger.submissions + 1 }), { mode: 0o600 })
    await port.call('begin', { id, objectId: 'cup', motif: 'sakura' }, abort.signal)
    for (let count = 0; count < 80; count++) {
      await new Promise<void>((done) => clock.after(Math.min(5000 + count * 1000, 15000), done)); abort.signal.throwIfAborted()
      const result = z.object({ state: z.enum(['waiting', 'ready', 'failed']), asset: binaryAssetSchema.optional() }).parse(await port.call('poll', { id }, abort.signal))
      if (result.state === 'failed') throw new Error('RODIN_TASK_FAILED')
      if (result.state === 'ready') { if (!result.asset) throw new Error('RODIN_RESULT_INVALID'); store.append({ type: 'asset/stored', asset: result.asset }); return { ok: true, probe: 'rodin', mcp: true, submitted: 1, totalNightSubmissions: ledger.submissions + 1, elapsedMs: clock.nowMs() - started, byteLength: result.asset.byteLength, sha256: result.asset.sha256 } }
    }
    throw new Error('RODIN_TASK_TIMEOUT')
  } catch { return { ok: false, probe: 'rodin', submitted: 1, totalNightSubmissions: ledger.submissions + 1, error: 'RODIN_LIVE_PROBE_FAILED' } }
  finally { stop(); abort.abort(); await port.close(); store.close() }
}

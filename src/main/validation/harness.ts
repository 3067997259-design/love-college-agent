import type { Clock } from '../clock'
import { readModelProviders } from '../config/providers'
import { createModelClient } from '../model/client'
import { openSessionStore } from '../store/session'
import { builtinTools } from '../harness/tools'
import { createHarness } from '../harness/loop'

export async function probeHarness(dataDir: string, filename: string, clock: Clock) {
  const providers = await readModelProviders(filename)
  if (!providers.has('chat')) return { ok: false, probe: 'harness', error: 'NOT_CONFIGURED' }
  const store = openSessionStore(dataDir, { userId: 'probe-user', characterId: 'probe-character' }, clock)
  const harness = createHarness({ store, clock, tools: builtinTools(), model: createModelClient(providers, ['chat'], clock), limits: { outputTokens: 128, steps: 4, dailyTokens: 30_000 } })
  const stop = clock.after(25_000, () => { void harness.dispose() })
  try {
    harness.send('Use get_clock exactly once, then reply with only OK. This is a synthetic execution test.', 'probe-request', 'probe-hash')
    await harness.idle()
    const rows = store.records()
    const call = rows.find((row) => row.type === 'tool/call' && row.name === 'get_clock')
    const toolVerified = Boolean(call && call.type === 'tool/call' && rows.some((row) => row.type === 'tool/result' && row.callId === call.callId && row.ok))
    const completed = store.projection().task?.status === 'completed'
    return { ok: completed && toolVerified, probe: 'harness', realModel: true, completed, toolVerified }
  } catch { return { ok: false, probe: 'harness', error: 'HARNESS_PROBE_FAILED' } }
  finally { stop(); await harness.dispose(); store.close() }
}

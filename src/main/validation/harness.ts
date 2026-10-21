import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../clock'
import { readModelProviders } from '../config/providers'
import { openSessionStore } from '../store/session'
import { builtinTools } from '../harness/tools'
import { createDshExecution } from '../dsh/execution'
import { dshLocations } from '../dsh/locations'
import { dshRoutes } from '../dsh/routes'

/**
 * Her execution with a real model: one DSH turn in a scratch project inside the probe data dir, where she reads LCA's
 * clock tool once. Booleans only; the model's words stay in the probe journal. Bounded to one turn and 90 seconds.
 */
export async function probeHarness(dataDir: string, filename: string, clock: Clock) {
  const chat = (await readModelProviders(filename)).get('chat')
  if (!chat) return { ok: false, probe: 'harness', error: 'NOT_CONFIGURED' }
  const { root, bridge, present } = dshLocations()
  if (!present) return { ok: false, probe: 'harness', error: 'DSH_RUNTIME_MISSING' }
  const store = openSessionStore(dataDir, { userId: 'probe-user', characterId: 'probe-character' }, clock)
  const project = join(dataDir, 'probe-project'); mkdirSync(project, { recursive: true })
  let finish!: () => void; const finished = new Promise<void>((resolve) => { finish = resolve })
  const ended = () => store.records().some((row) => row.type === 'turn/end')
  const execution = createDshExecution({ store, clock, dataDir, dshRoot: root, bridge, guardedRoots: [join(dataDir, 'journals'), join(dataDir, 'dsh-home')],
    routes: dshRoutes(chat, chat, {}), project: () => project, persona: () => 'This is a synthetic execution test.', suffix: () => '',
    tools: () => builtinTools().filter((tool) => tool.templateId === 'clock.read'), ask: async () => null, changed: () => { if (ended()) finish() } })
  const stop = clock.after(90_000, () => finish())
  try {
    execution.send('Use lca_get_clock exactly once, then reply with only OK. This is a synthetic execution test.', 'probe-request', 'probe-hash')
    await finished
    const rows = store.records()
    const completed = rows.some((row) => row.type === 'turn/end' && row.reason === 'completed')
    const toolVerified = rows.some((row) => row.type === 'work/activity' && row.templateId === 'clock.read' && row.status === 'completed')
    return { ok: completed && toolVerified, probe: 'harness', realModel: true, completed, toolVerified }
  } catch { return { ok: false, probe: 'harness', error: 'HARNESS_PROBE_FAILED' } }
  finally { stop(); await execution.close().catch(() => {}); store.close() }
}

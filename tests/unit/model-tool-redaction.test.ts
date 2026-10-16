import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createModelClient } from '../../src/main/model/client'
import { createHarness } from '../../src/main/harness/loop'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-redact-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) } })
it('redacts escaped provider values before actual harness parsing, execution, seen projection and journal persistence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-redact-')); roots.push(root); const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, append: journal.append, records: journal.records, projection: () => projectJournal(journal.records()), close: journal.close }
  const config = { base_url: 'https://synthetic.invalid/v1', api_key: 'synthetic-private-key', model: 'synthetic-config-model' }; let index = 0; let received: unknown
  const model = createModelClient(new Map([['chat', config]]), ['chat'], clock, async () => {
    const args = String.raw`{"text":"\u0073ynthetic-private-key","nested":[{"name":"\u0073ynthetic-config-model","url":"https:\/\/synthetic.invalid\/v1"}],"ordinary":"literal \"quote\""}`
    const delta = index++ === 0 ? { tool_calls: [{ index: 0, id: 'safe', function: { name: 'echo', arguments: args } }] } : { content: 'safe result' }
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: index === 1 ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
  const harness = createHarness({ store, clock, model, tools: [{ definition: { name: 'echo', description: 'test only', parameters: { type: 'object' } }, templateId: 'synthetic.echo', validate: () => true, run: async (args) => { received = args; return { ok: true, raw: { parsed: JSON.stringify(args) }, visible: { parsed: JSON.stringify(args) } } } }] })
  try {
    harness.send('synthetic public request', 'r', 'h'); await harness.idle()
    expect(received).toEqual({ text: '[redacted]', nested: [{ name: '[redacted]', url: '[redacted]' }], ordinary: 'literal "quote"' })
    const output = JSON.stringify(store.records()); for (const value of Object.values(config)) expect(output.includes(value)).toBe(false)
    expect(store.projection().task?.status).toBe('completed'); expect(index).toBe(2)
  } finally { await harness.dispose(); store.close() }
})

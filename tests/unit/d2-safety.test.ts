import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { JournalInput } from '../../src/main/journal/schema'
import type { SessionStore } from '../../src/main/store/session'
import { seenFragments } from '../../src/main/memory/seen'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-d2-'))) throw new Error('Unsafe test cleanup path')
  rmSync(root, { recursive: true, force: true })
} })
const owner = { userId: 'u', characterId: 'c' }
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lca-d2-')); roots.push(root)
  const clock = createManualClock(1_000)
  const journal = openJournal(root, owner, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, history: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
  const append = (input: JournalInput) => { journal.append(input); clock.advanceBy(1_000) }
  return { root, clock, journal, store, append }
}

describe('D2 timeline and safety gates', () => {
  it('keeps workspace tool results out of experience memory while ordinary chat remains eligible', () => {
    const f = setup()
    f.append({ type: 'turn/start', turnId: 'turn-1', trigger: 'user' })
    f.append({ type: 'tool/call', turnId: 'turn-1', callId: 'call-desk', name: 'desk_write', arguments: { path: 'answer.js', text: 'return 42' }, templateId: 'desk_write' })
    f.append({ type: 'tool/result', turnId: 'turn-1', callId: 'call-desk', ok: true, raw: { changeId: 'change-1' }, visible: { changeId: 'change-1' }, elapsedMs: 1 })
    f.append({ type: 'model/seen', turnId: 'turn-1', source: 'fake', messages: [
      { role: 'user', content: 'WRITE_REQUEST' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-desk', name: 'desk_write', arguments: '{}' }] },
      { role: 'tool', content: '{"changeId":"change-1"}', toolCallId: 'call-desk' },
      { role: 'assistant', content: 'WORK_REPLY' },
    ], eligibleIndexes: [0, 1, 2, 3] })
    f.append({ type: 'turn/end', turnId: 'turn-1', reason: 'completed' })
    expect(seenFragments(f.store.records(), true).map((fragment) => fragment.origin)).toEqual(['user'])
    const all = seenFragments(f.store.records(), false).map((fragment) => fragment.role)
    expect(all).toContain('tool'); expect(all).toContain('assistant')
    f.journal.close()
  })
})

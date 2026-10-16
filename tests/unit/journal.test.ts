import { mkdtempSync, readFileSync, readdirSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-journal-'))) throw new Error('Unsafe test cleanup path')
  rmSync(root, { recursive: true, force: true })
} })
function setup() { const root = mkdtempSync(join(tmpdir(), 'lca-journal-')); roots.push(root); return root }
const owner = { userId: 'u', characterId: 'c' }
function logPath(root: string) { const base = join(root, 'journals'); const folder = join(base, readdirSync(base)[0]); return join(folder, readdirSync(folder)[0]) }

describe('append-only fact source', () => {
  it('preserves bytes, scope and sequence across reopening; raw results never enter projections', () => {
    const root = setup(); const clock = createManualClock(1_000)
    const journal = openJournal(root, owner, clock)
    const scope = journal.scope
    journal.append({ type: 'user/message', id: 'm1', text: 'hello', requestId: 'r1', commandHash: 'h1' })
    const before = readFileSync(logPath(root))
    journal.append({ type: 'inbox/drain', ids: ['m1'] })
    journal.append({ type: 'assistant/message', turnId: 't1', id: 'a1', text: '', status: 'complete', toolCalls: [{ id: 'call1', name: 'read_test', arguments: '{}' }] })
    journal.append({ type: 'tool/result', turnId: 't1', callId: 'call1', raw: { secretSource: 'user-only synthetic evidence' }, visible: { count: 1 }, ok: true, elapsedMs: 5 })
    expect(readFileSync(logPath(root)).subarray(0, before.length)).toEqual(before)
    journal.close()
    const reopened = openJournal(root, owner, clock)
    expect(reopened.scope).toEqual(scope)
    expect(reopened.records().map((row) => row.seq)).toEqual([1, 2, 3, 4, 5])
    const view = projectJournal(reopened.records())
    expect(view.context[2]).toEqual({ role: 'tool', content: '{"count":1}', toolCallId: 'call1' })
    expect(JSON.stringify(view)).not.toContain('user-only synthetic evidence')
    expect(view.evidenceSeqs).toEqual([5])
    reopened.close()
    const other = openJournal(root, { ...owner, characterId: 'other' }, clock)
    expect(projectJournal(other.records()).messages).toEqual([])
    other.close()
  })
  it('fails closed on torn data without truncating the original log', () => {
    const root = setup(); const clock = createManualClock(0)
    openJournal(root, owner, clock).close()
    appendFileSync(logPath(root), '{"partial":')
    const before = readFileSync(logPath(root))
    expect(() => openJournal(root, owner, clock)).toThrow('JOURNAL_READ_FAILED')
    expect(readFileSync(logPath(root))).toEqual(before)
  })
  it('compacts model context while retaining chat and exact original events', () => {
    const journal = openJournal(setup(), owner, createManualClock(0))
    journal.append({ type: 'user/message', id: 'm', text: 'original', requestId: 'r', commandHash: 'h' })
    journal.append({ type: 'inbox/drain', ids: ['m'] })
    journal.append({ type: 'assistant/message', turnId: 't', id: 'a', text: 'response', status: 'complete' })
    journal.append({ type: 'context/compact', fromSeq: 2, toSeq: 4, summary: 'summary' })
    const view = projectJournal(journal.records())
    expect(view.context).toEqual([{ role: 'system', content: 'summary' }])
    expect(view.messages.map((message) => message.text)).toEqual(['original', 'response'])
    expect(journal.records()).toHaveLength(5)
    journal.close()
  })
})

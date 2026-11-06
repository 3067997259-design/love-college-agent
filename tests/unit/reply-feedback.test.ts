import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { seenFragments } from '../../src/main/memory/seen'
import { replyFeedbackPolicy } from '../../src/main/memory/feedback'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()))

it('marks a bad reply as no longer a memory source while keeping the user message', () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-reply-feedback-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-11-06T12:00:00+08:00'))
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock); cleanup.push(journal.close)
  journal.append({ type: 'user/message', id: 'u1', text: '我今天很累', requestId: 'r1', commandHash: 'h1' })
  journal.append({ type: 'turn/start', turnId: 't1', trigger: 'user' })
  journal.append({ type: 'inbox/drain', ids: ['u1'] })
  journal.append({ type: 'assistant/message', id: 'a1', turnId: 't1', text: '她的回复', status: 'complete' })
  journal.append({ type: 'model/seen', turnId: 't1', source: 'fake', eligibleIndexes: [0, 1],
    messages: [{ role: 'user', content: '我今天很累' }, { role: 'assistant', content: '她的回复' }], originalEvents: [{ index: 0, eventId: 'u1' }] })
  journal.append({ type: 'turn/end', turnId: 't1', reason: 'completed' })
  journal.append({ type: 'reply/feedback', id: 'f1', messageId: 'a1', turnId: 't1', verdict: 'bad' })

  expect(replyFeedbackPolicy(journal.records()).badTurns.has('t1')).toBe(true)
  expect(projectJournal(journal.records()).messages.find(message => message.id === 'a1')?.feedback).toBe('bad')
  const allowed = seenFragments(journal.records(), true, true).map(fragment => fragment.text)
  expect(allowed).toContain('我今天很累')
  expect(allowed).not.toContain('她的回复')
  // The retirement pass still sees the bad fragment, so an already extracted fact can be hidden.
  expect(seenFragments(journal.records(), true, true, false, true).map(fragment => fragment.text)).toContain('她的回复')
})

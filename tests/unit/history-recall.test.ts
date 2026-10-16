import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { ContextMessage } from '../../src/main/journal/schema'
import { projectMemory } from '../../src/main/memory/projection'
import { seenFragments } from '../../src/main/memory/seen'
import { createHistoryRecall } from '../../src/main/history/recall'
import type { SessionStore } from '../../src/main/store/session'
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-recall-')); cleanup.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-recall-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1_000_000); const owner = { userId: 'u', characterId: 'c' }; const old = openJournal(root, owner, clock)
  const messages: ContextMessage[] = []
  for (let index = 0; index < 5; index++) {
    const text = index === 3 ? '我们把纸桥命名为周五桥，放在窗边。' : '共同经历第' + index + '段。'
    old.append({ type: 'user/message', id: 'u' + index, text, requestId: 'u' + index, commandHash: 'h' }); old.append({ type: 'inbox/drain', ids: ['u' + index] }); messages.push({ role: 'user', content: text })
    old.append({ type: 'assistant/message', id: 'a' + index, turnId: 'old', text: '她的合成回应第' + index + '段。', status: 'complete' }); messages.push({ role: 'assistant', content: '她的合成回应第' + index + '段。' })
  }
  old.append({ type: 'tool/result', turnId: 'private', callId: 'private', ok: true, raw: { body: 'RAW_ONLY_MAIL_ATTACHMENT_DOCUMENT' }, visible: { text: 'RAW_TOOL_MUST_NOT_RECALL' }, elapsedMs: 0 })
  old.append({ type: 'inbox/event', id: 'mail-event', source: 'mail', text: 'MAIL_NOTIFICATION_MUST_NOT_RECALL' }); old.append({ type: 'inbox/drain', ids: ['mail-event'] })
  messages.push({ role: 'tool', content: 'RAW_TOOL_MUST_NOT_RECALL', toolCallId: 'private' }, { role: 'user', content: JSON.stringify({ source: 'mail', facts: 'MAIL_NOTIFICATION_MUST_NOT_RECALL' }) })
  old.append({ type: 'model/seen', turnId: 'seen', source: 'fake', messages, eligibleIndexes: messages.map((_, index) => index) })
  old.append({ type: 'user/message', id: 'unseen', text: 'UNDELIVERED_MUST_NOT_RECALL', requestId: 'unseen', commandHash: 'h' })
  old.append({ type: 'assistant/message', id: 'unseen-reply', turnId: 'tail', text: 'UNSEEN_REPLY', status: 'complete' })
  old.append({ type: 'flow/open', id: 'flow', mode: 'execute', prefix: [] })
  old.append({ type: 'user/message', id: 'work', text: 'WORK_MUST_NOT_RECALL', requestId: 'work', commandHash: 'h' }); old.append({ type: 'inbox/drain', ids: ['work'] })
  old.append({ type: 'model/seen', turnId: 'flow', source: 'fake', messages: [{ role: 'user', content: 'WORK_MUST_NOT_RECALL' }], eligibleIndexes: [0] }); old.append({ type: 'flow/close', id: 'flow', summary: '{}' })
  const oldPage = { sessionId: old.scope.sessionId, dayKey: '1970-01-01', records: old.records() }; old.close(); clock.advanceBy(86400000)
  const current = openJournal(root, owner, clock); cleanup.push(current.close)
  const store: SessionStore = { scope: current.scope, records: current.records, append: current.append, projection: () => projectJournal(current.records()), close: current.close,
    history: () => [...oldPage.records, ...current.records()], pages: () => [oldPage, { sessionId: current.scope.sessionId, dayKey: '1970-01-02', records: current.records() }] }
  let busy = false
  const options = { store, repository: { view: () => projectMemory(store.history!()) }, photos: { photo: () => undefined }, changed: () => {}, canRecall: () => !busy, busy: () => busy,
    send: (text: string, requestId: string, commandHash: string) => { store.append({ type: 'user/message', id: 'q-' + requestId, text, requestId, commandHash }); store.append({ type: 'inbox/drain', ids: ['q-' + requestId] }); busy = true } }
  const recall = createHistoryRecall(options); const original = messages[6].content; const anchor = { sessionId: oldPage.sessionId, messageId: 'u3', start: 0, end: original.length }
  const prepared = { messages: [{ role: 'system' as const, content: 'policy' }, { role: 'user' as const, content: '这段经历呢？' }], eligibleIndexes: [1] }
  return { store, clock, oldPage, recall, options, anchor, prepared, busy: (value: boolean) => { busy = value } }
}
it('anchors only witnessed ordinary messages and excludes private sources, unseen text, and work', () => {
  const f = fixture(); const ids = f.recall.recallable(f.oldPage.sessionId)
  expect(ids).toHaveLength(10); expect(ids).toContain('u3'); expect(ids).toContain('a3')
  for (const messageId of ['unseen', 'unseen-reply', 'work', 'mail-event', 'private']) expect(f.recall.request({ ...f.anchor, messageId }, '问一句', 'bad', 'h')).toBe('invalid-command')
  expect(f.recall.request({ ...f.anchor, sessionId: 'another-character-session' }, '问一句', 'bad-owner', 'h')).toBe('invalid-command')
  expect(f.recall.request({ ...f.anchor, end: 9999 }, '问一句', 'bad-range', 'h')).toBe('invalid-command')
})
it('inserts bounded historical reference before the question without making it eligible as a new experience', () => {
  const f = fixture(); expect(f.recall.request(f.anchor, '这段经历呢？', 'request', 'h')).toBeUndefined()
  const prepared = f.recall.prepare('turn', f.prepared); expect(prepared.eligibleIndexes).toEqual([2]); expect(prepared.messages.at(-1)?.content).toBe('这段经历呢？')
  const reference = JSON.parse(prepared.messages[1].content).recalledSeenReference
  expect(reference.quote).toContain('周五桥'); expect(reference.excerpts).toHaveLength(5); expect(reference.excerpts.every((entry: { source: { frameSeq: number } }) => entry.source.frameSeq > 0)).toBe(true)
  for (const marker of ['RAW_ONLY_', 'RAW_TOOL_', 'MAIL_NOTIFICATION_', 'WORK_MUST_', 'UNDELIVERED_', 'UNSEEN_REPLY']) expect(JSON.stringify(prepared)).not.toContain(marker)
  expect(JSON.stringify(f.recall.view())).not.toContain('周五桥'); expect(f.recall.view().status).toBe('recalling')
  f.store.append({ type: 'turn/end', turnId: 'turn', reason: 'completed' }); f.busy(false)
  expect(createHistoryRecall(f.options).view().status).toBe('ready'); expect(f.recall.prepare('later-unrelated', f.prepared)).toEqual(f.prepared)
})
it('restricts model expansion to this quote and turn, with durable read limits', async () => {
  const f = fixture(); f.recall.request(f.anchor, '回忆', 'request', 'h'); f.recall.prepare('turn', f.prepared)
  const tool = f.recall.tool(); const context = { clock: f.clock, store: f.store, turnId: 'turn', signal: new AbortController().signal }
  expect(tool.validate({ requestId: 'request', relativeStart: -6, count: 2 })).toBe(true); expect(tool.validate({ requestId: 'request', relativeStart: -100, count: 20 })).toBe(false)
  const value = await tool.run({ requestId: 'request', relativeStart: -6, count: 2 }, context); expect(JSON.stringify(value)).toContain('共同经历第0段')
  await expect(tool.run({ requestId: 'another', relativeStart: 0, count: 1 }, context)).rejects.toThrow()
  await expect(tool.run({ requestId: 'request', relativeStart: 0, count: 1 }, { ...context, turnId: 'other' })).rejects.toThrow()
  for (let index = 1; index < 8; index++) await tool.run({ requestId: 'request', relativeStart: 0, count: 1 }, context)
  await expect(tool.run({ requestId: 'request', relativeStart: 0, count: 1 }, context)).rejects.toThrow('RECALL_BUDGET_EXCEEDED')
  f.recall.setEnabled(false); await expect(tool.run({ requestId: 'request', relativeStart: 0, count: 1 }, context)).rejects.toThrow()
})
it('keeps the reference and expansion available when the user interjects mid-turn (issue #12)', async () => {
  const f = fixture(); f.recall.request(f.anchor, '回忆', 'request', 'h')
  const first = f.recall.prepare('turn', f.prepared)
  expect(first.messages.some((message) => message.content.includes('recalledSeenReference'))).toBe(true)
  const context = { clock: f.clock, store: f.store, turnId: 'turn', signal: new AbortController().signal }
  expect((await f.recall.tool().run({ requestId: 'request', relativeStart: 0, count: 1 }, context)).ok).toBe(true)
  // 同回合内的普通插话：新 user/message 带自己的 requestId，不属于这次回忆。
  f.store.append({ type: 'user/message', id: 'interject', text: '顺便问一句别的。', requestId: 'interject', commandHash: 'h' })
  const second = f.recall.prepare('turn', f.prepared)
  expect(second.messages.some((message) => message.content.includes('recalledSeenReference'))).toBe(true)
  expect((await f.recall.tool().run({ requestId: 'request', relativeStart: 0, count: 1 }, context)).ok).toBe(true)
})
it('only attaches summary text grounded in allowed seen sources', () => {  const f = fixture(); const fragment = seenFragments(f.store.history!()).find((entry) => entry.text.includes('周五桥'))!
  const { id, sessionId, frameSeq, index, offset, atMs } = fragment; const source = { id, sessionId, frameSeq, index, offset, atMs }
  f.store.append({ type: 'memory/summary', summary: { id: 'safe', level: 'day', period: '1970-01-01', text: '周五桥', sources: [source], sourceSessionIds: [sessionId], source: 'fake' } })
  f.store.append({ type: 'memory/summary', summary: { id: 'bad-summary', level: 'week', period: '1969-12-29', text: 'RAW_PRIVATE_SUMMARY', sources: [source], sourceSessionIds: [sessionId], source: 'fake' } })
  f.recall.request(f.anchor, '回忆', 'request', 'h'); const prepared = f.recall.prepare('turn', f.prepared)
  expect(JSON.parse(prepared.messages[1].content).recalledSeenReference.summaries).toMatchObject([{ id: 'safe' }]); expect(JSON.stringify(prepared)).not.toContain('RAW_PRIVATE_SUMMARY')
})

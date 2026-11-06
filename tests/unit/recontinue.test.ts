import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createManualClock } from '../../src/main/clock'
import { openJournal, sessionDayKey, parseJournalContent } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { continuationPolicy } from '../../src/main/recontinue/policy'
import { createRecontinue } from '../../src/main/recontinue/service'
import { seenFragments } from '../../src/main/memory/seen'
import { authoredUserMessage } from '../../src/main/questions/authored'
import { witnessedPage } from '../../src/main/history/seen'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()))
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-recontinue-'))
  cleanup.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-recontinue-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-11-04T12:00:00+08:00'))
  const journal = openJournal(root, { userId: 'u', characterId: 'c' }, clock); cleanup.push(journal.close)
  const day = sessionDayKey(clock)
  const store: SessionStore = { ...journal, dayKey: () => day, history: journal.records, projection: () => projectJournal(journal.records()),
    pages: () => [{ sessionId: journal.scope.sessionId, dayKey: day, records: journal.records() }] }
  const say = (id: string, text: string) => {
    store.append({ type: 'user/message', id, text, requestId: id, commandHash: id })
    store.append({ type: 'turn/start', turnId: id, trigger: 'user' }); store.append({ type: 'inbox/drain', ids: [id] })
    store.append({ type: 'assistant/message', id: 'a-' + id, turnId: id, text: 'Reply ' + text, status: 'complete' })
    store.append({ type: 'model/seen', turnId: id, source: 'fake', eligibleIndexes: [0, 1], messages: [{ role: 'user', content: text }, { role: 'assistant', content: 'Reply ' + text }], originalEvents: [{ index: 0, eventId: id }] })
    store.append({ type: 'turn/end', turnId: id, reason: 'completed' })
  }
  say('safe', 'SAFE'); say('poison', 'POISON'); say('tail', 'TAIL')
  let broken = false
  const options: Parameters<typeof createRecontinue>[0] = { store, clock, unavailable: () => false, changed: () => {},
    execution: () => ({ inspectRecontinue: async target => ({ sourceId: 'old', target, cwd: root, plan: { messageSeq: 3, boundary: 2, prefixDigest: 'a'.repeat(64), messageDigest: 'b'.repeat(64) } }),
      recontinue: async (_fork, _id, commit) => { if (broken) throw new Error('fixture-before-commit'); commit() } }),
    impact: () => ({ memories: 1, works: 0, effects: 0, version: '0' }), quiesce: async () => {} }
  const service = createRecontinue(options)
  const send = (body: Omit<Extract<AppCommand, { type: 'recontinue.preview' }>, 'protocolVersion' | 'epoch' | 'requestId'> | { type: 'recontinue.commit'; previewId: string }) => service.dispatch({ ...body, protocolVersion: 1, epoch: 'epoch', requestId: 'request' })
  const preview = async (messageId = 'poison', sessionId = store.scope.sessionId) => { send({ type: 'recontinue.preview', messageId, sessionId, revision: service.view().revision }); await settle(); return service.view().preview }
  return { store, clock, service, options, say, send, preview, break: () => { broken = true } }
}
it('withdraws a suffix from context, memory and decisions while preserving raw history and executed facts', async () => {
  const f = fixture()
  f.store.append({ type: 'companion/mode', mode: 'work', requestId: 'mode', commandHash: 'mode' })
  const before = JSON.stringify(f.store.records()), preview = await f.preview()
  expect(preview?.messages).toBe(4)
  expect(f.send({ type: 'recontinue.commit', previewId: preview!.id })).toBeUndefined(); await settle()
  expect(f.service.view().phase).toBe('complete')
  expect(f.store.projection().messages.map(row => row.id)).toEqual(['safe', 'a-safe'])
  expect(f.store.projection().mode).toBe('work')
  expect(JSON.stringify(f.store.records().slice(0, -1))).toBe(before)
  expect(JSON.stringify(f.store.projection().context)).not.toMatch(/POISON|TAIL/)
  expect(seenFragments(f.store.records(), true, true).map(row => row.text).join()).not.toMatch(/POISON|TAIL/)
  expect(seenFragments(f.store.records(), true, true, true).map(row => row.text).join()).toContain('POISON')
  expect(authoredUserMessage(f.store.records(), 'poison')).toBeNull()
  expect(witnessedPage(f.store, f.store.scope.sessionId).map(row => row.messageId)).not.toContain('poison')
  expect(f.service.view().completed?.draft).toBe('POISON')
  expect(f.store.records().filter(row => row.type === 'user/message')).toHaveLength(3)
})
it('refuses another day and a preview that crosses the 04:00 boundary', async () => {
  const f = fixture(); await f.preview('poison', '2026-11-03')
  expect(f.service.view().error).toContain('今天这页')
  const preview = await f.preview()
  f.clock.advanceBy(16 * 3600_000)
  f.send({ type: 'recontinue.commit', previewId: preview!.id }); await settle()
  expect(f.service.view().error).toContain('凌晨四点')
  expect(continuationPolicy(f.store.records()).revision).toBe('initial')
})
it('refuses a changed preview and leaves the original version after a preparation failure', async () => {
  const f = fixture(); let preview = await f.preview(); f.say('new', 'NEW')
  f.send({ type: 'recontinue.commit', previewId: preview!.id }); await settle()
  expect(f.service.view().error).toContain('重新预览')
  preview = await f.preview(); f.break(); f.send({ type: 'recontinue.commit', previewId: preview!.id }); await settle()
  expect(continuationPolicy(f.store.records()).revision).toBe('initial')
  expect(f.store.projection().messages).toHaveLength(8)
})
it('replays the commit and draft after restart, rejects old versions and accepts the first current message', async () => {
  const f = fixture(); const preview = await f.preview()
  f.send({ type: 'recontinue.commit', previewId: preview!.id }); await settle()
  const replayed = parseJournalContent(f.store.records().map(row => JSON.stringify(row)).join('\n') + '\n', f.store.scope)
  expect(projectJournal(replayed)).toEqual(f.store.projection())
  const restarted = createRecontinue(f.options)
  expect(restarted.view().completed?.draft).toBe('POISON')
  expect(restarted.dispatch({ type: 'recontinue.commit', previewId: preview!.id, protocolVersion: 1, epoch: 'epoch', requestId: 'retry' })).toBeUndefined()
  expect(continuationPolicy(f.store.records()).commits).toHaveLength(1)
  await f.preview('poison'); expect(f.service.view().error).toContain('当前版本')
  const first = await f.preview('safe'); f.send({ type: 'recontinue.commit', previewId: first!.id }); await settle()
  expect(f.store.projection().messages).toEqual([])
  expect(continuationPolicy(f.store.records()).commits).toHaveLength(2)
})
it('does not reintroduce a withdrawn original through a late worker observation', async () => {
  const f = fixture(), preview = await f.preview()
  f.send({ type: 'recontinue.commit', previewId: preview!.id }); await settle()
  f.store.append({ type: 'model/seen', turnId: 'late', source: 'fake', eligibleIndexes: [0], messages: [{ role: 'user', content: 'POISON' }], originalEvents: [{ index: 0, eventId: 'poison' }] })
  expect(seenFragments(f.store.records(), true, true).map(row => row.text).join()).not.toContain('POISON')
})

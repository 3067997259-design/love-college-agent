import { describe, expect, it } from 'vitest'
import type { JournalInput, JournalRecord } from '../../src/main/journal/schema'
import { seenFragments } from '../../src/main/memory/seen'
import { createFakeMemoryModel, validateMemories, validateSummary } from '../../src/main/memory/model'
import { projectMemory } from '../../src/main/memory/projection'
import { relevance, searchMemories } from '../../src/main/memory/retrieval'
import { projectJournal } from '../../src/main/journal/projection'

const owner = { userId: 'u', characterId: 'c' }
function records(inputs: JournalInput[], sessionId = 's1'): JournalRecord[] {
  return [{ type: 'session/header', ...owner, sessionId } as JournalInput, ...inputs].map((input, index) => ({ ...input, version: 1, seq: index + 1, atMs: index * 1000 }))
}
function seen(text = '我把纸桥放在书桌上，给它取名叫周五桥。', sessionId = 's1') {
  return seenFragments(records([{ type: 'model/seen', turnId: 'turn', source: 'fake', messages: [{ role: 'user', content: text }], eligibleIndexes: [0] }], sessionId))
}
describe('memory provenance, scope, retrieval and correction', () => {
  it('reads only successful model views and excludes raw results, unseen input and noneligible references', () => {
    const rows = records([
      { type: 'user/message', id: 'unseen', text: 'UNSEEN_USER', requestId: 'r', commandHash: 'h' },
      { type: 'tool/result', turnId: 't', callId: 'c', ok: true, raw: { original: 'RAW_ONLY_SOURCE' }, visible: { count: 1 }, elapsedMs: 0 },
      { type: 'model/seen', turnId: 't', source: 'fake', messages: [{ role: 'system', content: 'POLICY_ONLY' }, { role: 'user', content: 'REFERENCE_ONLY' }, { role: 'tool', content: '{"count":1}', toolCallId: 'c' }], eligibleIndexes: [2] },
      { type: 'model/seen', turnId: 't2', source: 'fake', messages: [{ role: 'tool', content: '{"count":1}', toolCallId: 'c' }], eligibleIndexes: [0] },
    ])
    const fragments = seenFragments(rows)
    expect(fragments).toHaveLength(1); expect(fragments[0].text).toBe('{"count":1}')
    expect(JSON.stringify(fragments)).not.toMatch(/RAW_ONLY_SOURCE|UNSEEN_USER|REFERENCE_ONLY|POLICY_ONLY/)
  })
  it('grounds fake extraction in exact visible quotes and generates different ids for another scope', async () => {
    const input = seen(); const fake = createFakeMemoryModel(); const output = await fake.model.extract(input, new AbortController().signal)
    const [item] = validateMemories(output, input, owner, [])
    expect(item.text).toContain('周五桥'); expect(item.sources[0].sessionId).toBe('s1')
    expect(validateMemories(output, input, { ...owner, characterId: 'other' }, [])[0].id).not.toBe(item.id)
    expect(() => validateMemories({ items: [{ sourceId: input[0].id, quote: 'invented', kind: 'fact', topic: 'invented', replaceTopic: false }] }, input, owner, [])).toThrow()
    expect(() => validateSummary({ lines: [{ sourceId: input[0].id, quote: 'invented' }] }, input)).toThrow()
  })
  it('preserves old facts with a supersession link, including two corrections in one extraction batch', async () => {
    const input = seen('我喜欢的饮料是咖啡。我喜欢的饮料现在改为红茶，不再喝咖啡。')
    const output = await createFakeMemoryModel().model.extract(input, new AbortController().signal)
    const entries = validateMemories(output, input, owner, [])
    expect(entries[1].supersedes).toEqual([entries[0].id])
    const state = projectMemory(records([{ type: 'memory/batch', batchId: 'a'.repeat(64), keys: [], entries, source: 'fake' }]))
    expect(state.items[0].supersededBy).toBe(state.items[1].id)
    expect(searchMemories(state.items, '饮料', 10_000).map((entry) => entry.item.id)).toEqual([state.items[1].id])
  })
  it('promotes only with three distinct accesses and evidence in two daily sessions', async () => {
    const fake = createFakeMemoryModel(); const input = seen(); const entries = validateMemories(await fake.model.extract(input, new AbortController().signal), input, owner, [])
    const id = entries[0].id
    const rows: JournalInput[] = [{ type: 'memory/batch', batchId: 'b'.repeat(64), keys: [], entries, source: 'fake' },
      ...['r1', 'r2', 'r3', 'r3'].map((requestId): JournalInput => ({ type: 'memory/access', ids: [id], requestId, sessionId: 's1' }))]
    expect(projectMemory(records(rows)).items[0]).toMatchObject({ accessCount: 3, tier: 'short_term' })
    const second = seen(undefined, 's2'); const repeated = validateMemories(await fake.model.extract(second, new AbortController().signal), second, owner, [])
    rows.push({ type: 'memory/batch', batchId: 'c'.repeat(64), keys: [], entries: repeated, source: 'fake' })
    expect(projectMemory(records(rows)).items[0]).toMatchObject({ accessCount: 3, tier: 'long_term', reviewStatus: 'unreviewed' })
  })
  it('matches two-character Chinese queries and does not return unrelated decayed memories', () => {
    expect(relevance('纸桥', '我们一起完成纸桥')).toBeGreaterThan(0)
    expect(relevance('线代', '线代作业')).toBeGreaterThan(0); expect(relevance('纸桥', '邮件')).toBe(0)
  })
  it('places a compacted summary before the retained new user input without deleting user chat', () => {
    const rows = records([{ type: 'user/message', id: 'one', text: 'old', requestId: 'one', commandHash: 'h' }, { type: 'inbox/drain', ids: ['one'] },
      { type: 'assistant/message', id: 'reply', turnId: 't', text: 'old reply', status: 'complete' },
      { type: 'user/message', id: 'new', text: 'current user', requestId: 'new', commandHash: 'h' }, { type: 'inbox/drain', ids: ['new'] },
      { type: 'context/compact', fromSeq: 2, toSeq: 4, summary: 'old summary' }])
    const before = JSON.stringify(rows); const projected = projectJournal(rows)
    expect(projected.context.map((message) => message.content)).toEqual(['old summary', 'current user'])
    expect(projected.messages).toHaveLength(3); expect(JSON.stringify(rows)).toBe(before)
  })
})

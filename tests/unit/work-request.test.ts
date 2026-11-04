import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import type { ToolContext } from '../../src/main/harness/tools'
import { createContinuousWork } from '../../src/main/work/service'
import { workTools } from '../../src/main/work/tools'
import { authoredUserMessage } from '../../src/main/questions/authored'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(count = 2) {
  const root = mkdtempSync(join(tmpdir(), 'lca-work-request-')), clock = createManualClock(1_790_000_000_000)
  const journal = openJournal(join(root, 'journal'), { userId: 'u', characterId: 'c' }, clock)
  cleanup.push(journal.close)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const messages: string[] = [], delivered: { text: string; eventId: string }[] = []
  const say = (text: string) => { const id = randomUUID(); store.append({ type: 'user/message', id, text, requestId: id, commandHash: id }); messages.push(id); return id }
  const options = { root: join(root, 'work'), owner: { userId: 'u', characterId: 'c', dataRootId: 'test' }, clock,
    project: (id: string) => ({ id, path: root }), safeText: (text: string) => text, available: () => true, held: () => false, changed: () => {},
    decision: (id: string) => authoredUserMessage(store.records(), id),
    createRuntime: () => ({ deliver: async (input: { text: string; eventId: string }) => { delivered.push(input) }, invalidateWork: () => {}, close: async () => {}, busy: () => true, stateChanged: () => {}, untrust: () => {}, efforts: () => {} }) }
  let service = createContinuousWork(options)
  cleanup.push(() => service.close())
  const initial = ['请启动独立工作「海报」：result.txt 写 TEA。', '请启动独立工作 WORK_B：处理表格，result.txt 写 TEA。', '请启动独立工作 OLD：result.txt 写 COFFEE。']
  const works = initial.slice(0, count).map((text, index) => {
    const id = say(text)
    return service.dispatch({ type: 'work.create', projectId: String(index), objective: text, acceptance: [], decisionIds: [id] }, 'seed-' + id).work!.identity.workId
  })
  for (let n = 0; n < 8; n++) await Promise.resolve()
  const context = (): ToolContext => ({ clock, store, turnId: 'foreground-turn', callId: randomUUID(), signal: new AbortController().signal,
    userMessageId: messages.at(-1), userMessageIds: [...messages] })
  const run = async (name: 'work.create' | 'work.update' | 'work.query', input: Record<string, unknown>, ctx = context()) => {
    store.append({ type: 'work/activity', turnId: ctx.turnId, callId: ctx.callId!, templateId: name, status: 'running' })
    const result = await workTools(service).find(tool => tool.templateId === name)!.run(input, ctx)
    return result.visible as Record<string, unknown>
  }
  const update = (workId = works[1] ?? works[0], input: Record<string, unknown> = {}, ctx = context()) => run('work.update', {
    workId, expectedRevision: service.get(workId)!.revision, action: 'supplement', ...input,
  }, ctx)
  const create = (input: Record<string, unknown> = {}) => run('work.create', { objective: 'MODEL INVENTED COFFEE', acceptance: ['COFFEE'], ...input })
  const snapshot = () => service.requestWorks().map(work => ({ identity: work.identity, decisions: work.decisions, inputs: work.inputs, objective: work.objective }))
  const reply = (text: string, { approval = false, committed = true, turnId = 'foreground-turn', multiple = false } = {}) => {
    const id = randomUUID(), callId = randomUUID()
    store.append({ type: 'question/requested', id, turnId, callId, question: 'Model proposes a change to COFFEE?', choices: ['WORK_B'], ...(approval ? { approval: true as const } : {}),
      ...(multiple ? { items: [{ id: 'target', header: 'WORK_B', question: 'Target?', options: [], multiSelect: false }, { id: 'change', header: 'COFFEE', question: 'Change?', options: [], multiSelect: false }] } : {}) })
    const answerMessageId = say(text)
    store.append({ type: 'question/answered', id, turnId, answerMessageId })
    if (committed) store.append({ type: 'question/committed', id, turnId, answerMessageId })
    return answerMessageId
  }
  return { say, reply, run, update, create, snapshot, context, works, messages, delivered, get: (id: string) => service.get(id)!,
    reopen: async () => { await service.close(); service = createContinuousWork(options) } }
}

describe('current authored work requests, independent of model obedience', () => {
  it('exposes the same interrupted outcome in list and exact work queries without resuming', async () => {
    const f = await fixture(1), id = f.works[0]
    f.say(`停止工作 ${id}。`)
    expect(await f.update(id, { action: 'stop' })).not.toHaveProperty('error')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    const exact = await f.run('work.query', { workId: id })
    const list = await f.run('work.query', {})
    expect(exact).toMatchObject({ status: 'stopped', result: { completion: 'unverified', interruption: { reason: 'stopped', generation: 1 } } })
    expect(list).toMatchObject({ items: [{ result: exact.result }] })
    expect(JSON.stringify(exact.result)).toContain('先核对')
    expect(JSON.stringify(exact.result)).not.toContain('projectPath')
    expect(f.get(id).identity.generation).toBe(1)
  })
  it('replays candidate 6 query -> guessed update -> invented create without any mutation', async () => {
    const f = await fixture(3)
    const oldDecision = f.messages[2]
    f.say('把那个任务改一下。')
    const before = f.snapshot()
    await f.run('work.query', {})
    expect(await f.update()).toMatchObject({ error: 'work-clarification-required', reason: 'target-required', applied: false })
    expect(await f.create({ decisionIds: [oldDecision] })).toMatchObject({ error: 'work-clarification-required' })
    expect(await f.create()).toMatchObject({ error: 'work-clarification-required' })
    expect(f.snapshot()).toEqual(before)
  })

  it.each(['把那个任务改一下。', '调整一下任务。', 'Update that task.', '把那个任务改成 COFFEE。', '把输出改成 COFFEE。'])('does not guess between two roots: %s', async text => {
    const f = await fixture(); f.say(text); const before = f.snapshot()
    expect(await f.update()).toMatchObject({ error: 'work-clarification-required', reason: 'target-required' })
    expect(f.snapshot()).toEqual(before)
  })

  it.each(['改一下。', '稍微调整。', '按之前一样。'])('requires a concrete change even with the exact ID: %s', async text => {
    const f = await fixture(); f.say(`工作 ${f.works[1]}：${text}`); const before = f.snapshot()
    expect(await f.update()).toMatchObject({ error: 'work-clarification-required', reason: 'requirement-required' })
    expect(f.snapshot()).toEqual(before)
  })

  it('routes a clear amendment once, and cannot turn it into a new work even after reopen', async () => {
    const f = await fixture(); const text = `补充工作 ${f.works[1]}：result.txt 改成 COFFEE，不要 TEA。`, id = f.say(text)
    expect(await f.update()).not.toHaveProperty('error')
    const work = f.get(f.works[1]); expect(work.identity.objectiveRevision).toBe(2)
    expect(work.decisions.at(-1)).toMatchObject({ id, text })
    expect(await f.update()).toMatchObject({ alreadyApplied: true })
    expect(await f.create()).toMatchObject({ error: 'work-clarification-required', reason: 'request-already-bound-to-work' })
    expect(f.get(f.works[1]).identity.objectiveRevision).toBe(2)
    await f.reopen()
    expect(await f.create()).toMatchObject({ error: 'work-clarification-required' })
    expect(f.snapshot()).toHaveLength(2)
  })

  it.each([['WORK_B', 1, '把 WORK_B 的输出改为 MILK。'], ['海报', 0, '把海报的字体改小一点。']] as const)('accepts a unique original name: %s', async (quote, index, text) => {
    const f = await fixture(); f.say(text)
    expect(await f.update(f.works[index], { targetQuote: quote })).not.toHaveProperty('error')
    expect(f.get(f.works[index]).identity.objectiveRevision).toBe(2)
    expect(f.get(f.works[1 - index]).identity.objectiveRevision).toBe(1)
  })

  it('does not let a quote about the change override an explicit different target', async () => {
    const f = await fixture(); f.say(`把工作 ${f.works[0]} 的输出改成 COFFEE。`)
    expect(await f.update()).toMatchObject({ reason: 'target-required' })
  })

  it('does not mistake a unique historical output value for a task name', async () => {
    const f = await fixture(3); f.say('把那个任务改成 COFFEE。')
    expect(await f.update(f.works[2], { targetQuote: 'COFFEE' })).toMatchObject({ reason: 'target-required' })
    expect(await f.update(f.works[2])).toMatchObject({ reason: 'target-required' })
  })

  it('rejects unknown IDs and non-original quotes instead of falling back to the only root', async () => {
    const f = await fixture(1); f.say(`修改工作 ${randomUUID()}：输出改为 WATER。`)
    expect(await f.update()).toMatchObject({ reason: 'target-required' })
    f.say(`修改工作 ${f.works[0]}：输出改为 WATER。`)
    expect(await f.update(undefined, { requirementQuote: 'COFFEE' })).toMatchObject({ reason: 'quote-not-in-request' })
  })

  it('joins a committed clarification and delivers both originals in one revision', async () => {
    const f = await fixture(); const requestId = f.say('把那个任务的 result.txt 改成 COFFEE。'), answerId = f.reply('WORK_B')
    expect(await f.update(undefined, { targetQuote: 'WORK_B', requirementQuote: 'COFFEE' })).not.toHaveProperty('error')
    const work = f.get(f.works[1]); expect(work.identity.objectiveRevision).toBe(2)
    expect(work.decisions.slice(-2).map(item => item.id)).toEqual([requestId, answerId])
    expect(work.inputs.at(-1)?.decisionIds).toEqual([requestId, answerId])
    const delivered = JSON.parse(f.delivered.at(-1)!.text)
    expect(delivered.userDecisions.map((item: { id: string }) => item.id)).toEqual([requestId, answerId])
    expect(JSON.stringify(delivered)).not.toContain('Model proposes')
  })

  it.each([{ approval: true }, { committed: false }, { turnId: 'old-turn' }])('rejects approval, unfinished, and old-turn answers: %j', async options => {
    const f = await fixture(); f.say('把那个任务的 result.txt 改成 COFFEE。'); f.reply('WORK_B', options)
    const before = f.snapshot()
    expect(await f.update(undefined, { targetQuote: 'WORK_B' })).toMatchObject({ reason: 'current-request-required' })
    expect(f.snapshot()).toEqual(before)
  })

  it('does not adopt details written in the model question when the answer is only yes', async () => {
    const f = await fixture(1); f.say('把那个任务改一下。'); f.reply('好的')
    expect(await f.update()).toMatchObject({ reason: 'requirement-required' })
  })

  it('excludes model-written multi-question headings from both routing and stored decisions', async () => {
    const f = await fixture(); f.say('把那个任务改一下。'); f.reply('WORK_B：好的\nCOFFEE：好的', { multiple: true })
    expect(await f.update(undefined, { targetQuote: 'WORK_B', requirementQuote: 'COFFEE' })).toMatchObject({ reason: 'quote-not-in-request' })
    f.say('把那个任务的输出改成 TEA。'); const answer = f.reply('WORK_B：WORK_B\nCOFFEE：保持 TEA。', { multiple: true })
    expect(await f.update(undefined, { targetQuote: 'WORK_B' })).not.toHaveProperty('error')
    expect(f.get(f.works[1]).decisions.at(-1)).toMatchObject({ id: answer, text: 'WORK_B\n保持 TEA。' })
    expect(JSON.parse(f.delivered.at(-1)!.text).userDecisions.at(-1).text).toBe('WORK_B\n保持 TEA。')
  })

  it('honors withdrawal after a question and a later ordinary message supersedes its chain', async () => {
    const f = await fixture(); f.say('把那个任务的输出改为 COFFEE。'); f.reply('先不改，两个任务保持原要求。')
    const before = f.snapshot()
    expect(await f.update()).toMatchObject({ reason: 'request-withdrawn' })
    f.say('先不改。')
    expect(await f.create()).toMatchObject({ reason: 'request-withdrawn' })
    expect(f.snapshot()).toEqual(before)
  })

  it('starts from the current original, excludes invented acceptance, and deduplicates another call', async () => {
    const f = await fixture(); const text = '请启动独立工作 WORK_C：把 result.txt 写成 WATER。', id = f.say(text)
    expect(await f.create({ acceptance: ['WATER', 'COFFEE'] })).not.toHaveProperty('error')
    const work = f.snapshot().find(item => item.decisions.some(item => item.id === id))!
    expect(work.objective).toBe(text); expect(f.get(work.identity.workId).acceptance).toEqual(['WATER'])
    expect(await f.create()).toMatchObject({ alreadyApplied: true })
    expect(f.snapshot()).toHaveLength(3)
  })

  it('does not bind old decisions even when a fresh start request exists', async () => {
    const f = await fixture(); const oldId = f.messages[0]; f.say('帮我修复项目中的登录错误。')
    expect(await f.create({ decisionIds: [oldId] })).toMatchObject({ reason: 'historical-decision-not-current-request' })
    expect(await f.create()).not.toHaveProperty('error')
  })

  it('cannot bypass a rejected target by changing the next call to create', async () => {
    const f = await fixture(); f.say('把输出改成 COFFEE。'); const before = f.snapshot()
    expect(await f.update()).toMatchObject({ reason: 'target-required' })
    expect(await f.create()).toMatchObject({ reason: 'update-request-cannot-create-work' })
    expect(f.snapshot()).toEqual(before)
  })

  it('does not treat a status question as a supplement or a stop request', async () => {
    const f = await fixture(); f.say(`查看工作 ${f.works[1]} 的进度。`)
    expect(await f.update()).toMatchObject({ reason: 'current-request-required' })
    expect(await f.update(undefined, { action: 'stop' })).toMatchObject({ reason: 'current-request-required' })
  })

  it('still starts an explicit read-only project investigation', async () => {
    const f = await fixture(); f.say('请查看项目的 README 和测试脚本，说明如何运行测试。')
    expect(await f.create()).not.toHaveProperty('error')
  })

  it('keeps version checks and routes an explicit stop only to its named work', async () => {
    const f = await fixture(); f.say(`停止工作 ${f.works[1]}。`)
    expect(await f.update(undefined, { action: 'stop', expectedRevision: 999 })).toMatchObject({ error: 'invalid-command' })
    expect(await f.update(undefined, { action: 'stop' })).not.toHaveProperty('error')
    expect(['stopping', 'stopped']).toContain(f.get(f.works[1]).status)
    expect(f.get(f.works[0]).status).toBe('running')
  })
})

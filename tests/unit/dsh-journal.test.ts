import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createDshExecution, failureOf } from '../../src/main/dsh/execution'
import type { DshApproval, DshEvent, DshHostOptions, startDshHost } from '../../src/main/dsh/host'
import type { HarnessTool } from '../../src/main/harness/tools'
import { openJournal } from '../../src/main/journal/file'
import { witnessedPage } from '../../src/main/history/seen'
import { projectJournal } from '../../src/main/journal/projection'
import { seenFragments } from '../../src/main/memory/seen'
import type { SessionStore } from '../../src/main/store/session'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-dsh-journal-'))) throw new Error('Unsafe test cleanup path')
  rmSync(root, { recursive: true, force: true })
} })

const mailTool: HarnessTool = { definition: { name: 'read_mail', description: 'synthetic', parameters: { type: 'object', properties: {} } }, templateId: 'mail.read',
  validate: () => true, run: async () => ({ ok: true, raw: {}, visible: { subject: 'synthetic' } }) }
// Her question to you: the answer is a user/message in the journal, the tool result only names it (questions/service.ts).
const askTool: HarnessTool = { definition: { name: 'ask_user', description: 'synthetic', parameters: { type: 'object', properties: {} } }, templateId: 'user.ask',
  validate: () => true, run: async (_input, context) => { context.store.append({ type: 'user/message', id: 'answer-1', text: '用 Markdown', requestId: 'answer-1', commandHash: 'h' }); return { ok: true, raw: { status: 'answered', answerMessageId: 'answer-1' }, visible: { status: 'answered', answerMessageId: 'answer-1' } } } }
const fileTool: HarnessTool = { definition: { name: 'read_uploaded_file', description: 'synthetic', parameters: { type: 'object', properties: {} } }, templateId: 'document.read',
  validate: () => true, run: async () => ({ ok: true, raw: { documentId: 'doc-1', sourceRead: true }, visible: { documentId: 'doc-1', sourceRead: true }, original: 'UPLOADED_ORIGINAL' }) }

function setup(dataDir?: string, admit?: (input: { bucket: 'work' | 'autonomous'; units: number }) => 'budget-exceeded' | 'unavailable' | null, revealed?: () => { reference: Record<string, unknown>; text: string; source: 'mail' } | null) {
  const root = dataDir ?? mkdtempSync(join(tmpdir(), 'lca-dsh-journal-')); if (!dataDir) roots.push(root)
  const clock = createManualClock(1_000)
  const journal = openJournal(join(root, 'journal'), { userId: 'u', characterId: 'c' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
  const asked: { question: string; choices: string[] }[] = []
  let project = join(root, 'project')
  let answer: (choices: string[]) => string | null = (choices) => choices[0]
  const host = { options: undefined as DshHostOptions | undefined, opened: [] as unknown[][], sent: [] as string[], references: [] as (string | null)[], modes: [] as string[], origins: [] as string[], degrades: [] as string[][], trusted: [] as string[], current: 'dsh-1' }
  const referenceAsks: boolean[] = []
  const startedTurns: { turnId: string; requestId: string }[] = []
  const answeredCalls: { turnId: string; callId: string }[] = []
  const launch = ((options: DshHostOptions) => {
    host.options = options
    return { started: Promise.resolve(), open: async (...args: unknown[]) => { host.opened.push(args); const id = typeof args[1] === 'string' ? args[1] : `dsh-${host.opened.length}`; host.current = id; return id }, trust: (id: string) => { host.trusted.push(id) },
      send: (_id: string, text: string, mode = 'followup', reference: string | null = null, origin = 'user', degrade: string[] = []) => { host.sent.push(text); host.references.push(reference); host.modes.push(mode); host.origins.push(origin); host.degrades.push(degrade) }, cancel: () => {}, close: async () => null }
  }) as unknown as typeof startDshHost
  const execution = createDshExecution({ store, clock, dataDir: root, dshRoot: 'unused', bridge: 'unused', routes: { env: {}, chat: { provider: 'deepseek-official', model: 'deepseek-flash' }, work: { provider: 'deepseek-official', model: 'deepseek-flash' } }, guardedRoots: [],
    project: () => project, persona: () => '', suffix: () => '', tools: () => [mailTool, fileTool, askTool],
    ask: async (question, choices) => { asked.push({ question, choices }); return answer(choices) }, changed: () => {}, launch, admit, revealed, started: (input) => { startedTurns.push(input) }, answered: (input) => { answeredCalls.push(input) },
    reference: ({ firstOfSession }) => { referenceAsks.push(firstOfSession); return { memoryReference: [{ text: '你喜欢用 TypeScript' }], ...(firstOfSession ? { previousDaysReference: [{ text: '昨天一起写了质数脚本' }] } : {}) } } })
  const emit = (event: Omit<DshEvent, 'sessionId'>) => host.options!.onEvent({ sessionId: host.current, ...event } as DshEvent)
  const approval = (patch: Partial<DshApproval>) => host.options!.onApproval({ sessionId: 'dsh-1', toolName: 'pwsh', callId: 'call-x', reason: null, kind: 'escalation', command: 'node a.js', subject: 'node a.js', degraded: null, ...patch })
  const opened = async () => { for (let i = 0; i < 20 && !host.sent.length; i++) await Promise.resolve() }
  return { root, clock, journal, store, execution, host, emit, approval, asked, opened, referenceAsks, startedTurns, answeredCalls, setProject: (next: string) => { project = next }, setAnswer: (next: typeof answer) => { answer = next } }
}

async function workTurn(f: ReturnType<typeof setup>) {
  f.execution.send('帮我跑一下 count.js', 'r-1', 'h-1')
  await f.opened()
  f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
  f.emit({ t: 'message', text: '我先跑一下看看。', toolCalls: [{ id: 'call-1', name: 'pwsh' }] })
  f.emit({ t: 'tool-call', callId: 'call-1', name: 'pwsh', args: JSON.stringify({ command: 'node count.js' }) })
  f.emit({ t: 'tool-result', callId: 'call-1', isError: false })
  f.emit({ t: 'message', text: '跑出来了，一共 1229 个。', toolCalls: [] })
  f.emit({ t: 'turn-end', turn: 1, reason: { kind: 'completed' } })
}

describe('DSH work in the LCA journal', () => {
  it('keeps the conversation and activity rows but no tool traffic in LCA context', async () => {
    const f = setup()
    await workTurn(f)
    const records = f.store.records()
    expect(records.some((row) => row.type === 'tool/call' || row.type === 'tool/result')).toBe(false)
    expect(records.filter((row) => row.type === 'assistant/message').every((row) => row.type === 'assistant/message' && !row.toolCalls)).toBe(true)
    const turnId = (records.find((row) => row.type === 'turn/start') as { turnId: string }).turnId
    expect(records.find((row) => row.type === 'work/turn')).toMatchObject({ turnId, engine: 'dsh', sessionId: 'dsh-1', preset: 'workspace-write' })
    const view = f.store.projection()
    expect(view.context.map((message) => [message.role, message.content])).toEqual([['user', '帮我跑一下 count.js'], ['assistant', '我先跑一下看看。'], ['assistant', '跑出来了，一共 1229 个。']])
    expect(view.context.some((message) => message.role === 'tool' || message.toolCalls)).toBe(false)
    const started = (records.find((row) => row.type === 'work/activity') as { atMs: number }).atMs
    expect(view.activities).toEqual([{ id: 'call-1', taskId: turnId, toolCallId: 'call-1', templateId: 'dsh.shell', status: 'completed', fields: {}, startedAtMs: started }])
    // The turn your message opened is named to LCA (an old-page quote sent with it moves to this turn).
    expect(f.startedTurns).toEqual([{ turnId, requestId: 'r-1' }])
    expect(view.evidenceSeqs).toEqual([])
    expect(view.task).toMatchObject({ id: turnId, status: 'completed' })
    f.journal.close()
  })

  it('drops the step handed to the work model from the book and keeps the step the work model ran', async () => {
    const f = setup()
    f.execution.send('写个脚本', 'r-1', 'h-1')
    await f.opened()
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    f.emit({ t: 'tool-call', callId: 'call-chat', name: 'write', args: JSON.stringify({ file_path: 'a.js', content: 'x' }) })
    f.emit({ t: 'handoff', callId: 'call-chat' })
    f.emit({ t: 'tool-result', callId: 'call-chat', isError: true })
    f.emit({ t: 'tool-call', callId: 'call-work', name: 'write', args: JSON.stringify({ file_path: 'a.js', content: 'y' }) })
    f.emit({ t: 'tool-result', callId: 'call-work', isError: false })
    f.emit({ t: 'turn-end', turn: 1, reason: { kind: 'completed' } })
    expect(f.store.projection().activities.map((activity) => [activity.toolCallId, activity.status])).toEqual([['call-work', 'completed']])
    f.journal.close()
  })

  it('records what she saw in a DSH turn: your lines and her replies, never tool traffic', async () => {
    const f = setup()
    await workTurn(f)
    const turnId = (f.store.records().find((row) => row.type === 'work/turn') as { turnId: string }).turnId
    const seen = f.store.records().filter((row) => row.type === 'model/seen')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ turnId, source: 'real', messages: [{ role: 'user', content: '帮我跑一下 count.js' }, { role: 'assistant', content: '我先跑一下看看。' }, { role: 'assistant', content: '跑出来了，一共 1229 个。' }], eligibleIndexes: [0, 1, 2] })
    // Old pages can quote DSH lines again: a later frame shows she saw them.
    expect(witnessedPage(f.store, f.store.scope.sessionId).map((message) => message.text)).toEqual(['帮我跑一下 count.js', '我先跑一下看看。', '跑出来了，一共 1229 个。'])
    f.journal.close()
  })

  it('sends memory references beside your words: earlier days only with the first message of a fresh session', async () => {
    const f = setup()
    await workTurn(f)
    f.execution.send('再加个测试', 'r-2', 'h-2')
    for (let i = 0; i < 20 && f.host.sent.length < 2; i++) await Promise.resolve()
    expect(f.referenceAsks).toEqual([true, false])
    expect(JSON.parse(f.host.references[0]!)).toHaveProperty('previousDaysReference')
    expect(JSON.parse(f.host.references[1]!)).not.toHaveProperty('previousDaysReference')
    expect(f.host.sent).toEqual(['帮我跑一下 count.js', '再加个测试'])
    // The references are not your words: the journal and what she saw keep only your lines.
    expect(JSON.stringify(f.store.records())).not.toContain('memoryReference')
    f.journal.close()
  })

  it('gives events to the same session: a turn of their own when free, held while quiet, steered into a running turn', async () => {
    const f = setup()
    const settle = async (count: number) => { for (let i = 0; i < 30 && f.host.sent.length < count; i++) await Promise.resolve() }
    // Free and not quiet: the event opens a turn of its own.
    expect(f.execution.postEvent('pomodoro', '{"kind":"focus-ended"}', 'ev-1')).toBe(true)
    expect(f.execution.postEvent('pomodoro', '{"kind":"focus-ended"}', 'ev-1')).toBe(false)
    await settle(1)
    expect([f.host.modes[0], f.host.origins[0]]).toEqual(['followup', 'event'])
    expect(JSON.parse(f.host.sent[0])).toEqual({ source: 'pomodoro', facts: '{"kind":"focus-ended"}' })
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    f.emit({ t: 'message', text: '专注结束啦，休息一下吧。', toolCalls: [] })
    f.emit({ t: 'turn-end', turn: 1, reason: { kind: 'completed' } })
    expect(f.store.records().find((row) => row.type === 'turn/start')).toMatchObject({ trigger: 'pomodoro' })
    expect(f.store.projection().messages.at(-1)).toMatchObject({ text: '专注结束啦，休息一下吧。' })
    // Memory sees it as a pomodoro fact, not as your words.
    expect(seenFragments(f.store.records(), true).find((fragment) => fragment.role === 'user')).toMatchObject({ origin: 'pomodoro' })
    // Quiet: held until the beat allows it.
    f.store.append({ type: 'companion/mode', mode: 'quiet', requestId: 'm-1', commandHash: 'h-m1' })
    f.execution.postEvent('autonomous', '她读完了一章书', 'ev-2')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(f.host.sent).toHaveLength(1)
    f.store.append({ type: 'companion/mode', mode: 'rest', requestId: 'm-2', commandHash: 'h-m2' })
    f.execution.stateChanged()
    await settle(2)
    expect([f.host.modes[1], f.host.origins[1]]).toEqual(['followup', 'event'])
    f.emit({ t: 'turn-start', turn: 2, preset: 'workspace-write' })
    // While she is in a turn, a new event joins it at her next step.
    f.execution.postEvent('mail', '一封来自教务处的新邮件', 'ev-3')
    await settle(3)
    expect([f.host.modes[2], f.host.origins[2]]).toEqual(['steer', 'event'])
    f.emit({ t: 'turn-end', turn: 2, reason: { kind: 'completed' } })
    f.journal.close()
  })

  it('records a turn DSH aborted (your stop, an event cap) as aborted, not completed', async () => {
    const f = setup()
    f.execution.send('写个很长的东西', 'r-1', 'h-1')
    await f.opened()
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    f.emit({ t: 'turn-end', turn: 1, reason: { kind: 'aborted' } })
    expect(f.store.records().find((row) => row.type === 'turn/end')).toMatchObject({ reason: 'aborted' })
    f.journal.close()
  })

  it('keeps one session per project and brings the missed conversation of today to the other one', async () => {
    const f = setup()
    const settle = async (count: number) => { for (let i = 0; i < 30 && f.host.sent.length < count; i++) await Promise.resolve() }
    await workTurn(f)
    // Another project: its own session (own sandbox root and trust), told what was said before.
    f.setProject(join(f.root, 'course-site'))
    f.execution.send('换个项目，看看这个网站', 'r-2', 'h-2')
    await settle(2)
    expect(f.host.opened.map((args) => [args[0], args[1]])).toEqual([[join(f.root, 'project'), undefined], [join(f.root, 'course-site'), undefined]])
    const earlier = JSON.parse(f.host.references[1]!).earlierToday
    expect(earlier).toEqual([{ who: 'user', text: '帮我跑一下 count.js' }, { who: 'her', text: '我先跑一下看看。' }, { who: 'her', text: '跑出来了，一共 1229 个。' }])
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    f.emit({ t: 'message', text: '这是一个课程网站。', toolCalls: [] })
    f.emit({ t: 'turn-end', turn: 1, reason: { kind: 'completed' } })
    // Back to the first project: its own session resumes and hears only what it missed.
    f.setProject(join(f.root, 'project'))
    f.execution.send('回到刚才那个', 'r-3', 'h-3')
    await settle(3)
    expect(f.host.opened.at(-1)?.slice(0, 2)).toEqual([join(f.root, 'project'), 'dsh-1'])
    expect(JSON.parse(f.host.references[2]!).earlierToday).toEqual([{ who: 'user', text: '换个项目，看看这个网站' }, { who: 'her', text: '这是一个课程网站。' }])
    const saved = JSON.parse(readFileSync(join(f.root, 'dsh-sessions.json'), 'utf8'))
    expect(Object.values(saved)[0]).toHaveLength(2)
    f.journal.close()
  })

  it('holds turns that run without you to the autonomous allowance, records your own, and keeps the usage DSH reports', async () => {
    const asked: string[] = []
    const f = setup(undefined, ({ bucket }) => { asked.push(bucket); return bucket === 'autonomous' ? 'budget-exceeded' : null })
    const admit = (bucket: 'work' | 'autonomous', units = 16_000) => f.host.options!.onAdmit!({ sessionId: f.host.current, bucket, role: 'chat', units })
    await workTurn(f)
    f.execution.send('再说一句', 'r-2', 'h-2')
    for (let i = 0; i < 20 && f.host.sent.length < 2; i++) await Promise.resolve()
    f.emit({ t: 'turn-start', turn: 2, preset: 'workspace-write' })
    expect(admit('work')).toBe(true)
    f.emit({ t: 'message', text: '好。', toolCalls: [], usage: { inputTokens: 1200, outputTokens: 30, cacheReadTokens: 900 } })
    f.emit({ t: 'turn-end', turn: 2, reason: { kind: 'completed' } })
    const attempts = f.store.records().filter((row) => row.type === 'model/attempt')
    expect(attempts.map((row) => row.type === 'model/attempt' && [row.status, row.bucket ?? null, row.inputTokens ?? null, row.cachedInputTokens ?? null])).toEqual([['started', 'work', null, null], ['success', null, 1200, 900]])
    // An event turn past its allowance stops and says why.
    f.execution.postEvent('autonomous', '她读完了一章书', 'ev-1')
    for (let i = 0; i < 20 && f.host.sent.length < 3; i++) await Promise.resolve()
    f.emit({ t: 'turn-start', turn: 3, preset: 'workspace-write' })
    expect(admit('autonomous')).toBe(false)
    f.emit({ t: 'turn-end', turn: 3, reason: { kind: 'aborted' } })
    expect(asked).toEqual(['work', 'autonomous'])
    expect(f.store.projection().messages.at(-1)).toMatchObject({ role: 'narrator', failure: { code: 'budget-exceeded' } })
    f.journal.close()
  })

  it('sends a mail original you asked to see once, and keeps that session degraded', async () => {
    let shown = false
    const f = setup(undefined, undefined, () => { if (shown) return null; shown = true; return { source: 'mail', text: 'ORIGINAL_MAIL_BODY', reference: { revealedOriginal: { source: 'mail', subject: '教务通知' } } } })
    f.execution.send('这封邮件说了什么？', 'r-1', 'h-1')
    await f.opened()
    expect(f.host.references[0]).toContain('"revealedOriginal"')
    expect(f.host.references[0]!.endsWith('ORIGINAL_MAIL_BODY')).toBe(true)
    expect(f.host.degrades[0]).toEqual(['mail'])
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    f.emit({ t: 'turn-end', turn: 1, reason: { kind: 'completed' } })
    f.execution.send('那就这样', 'r-2', 'h-2')
    for (let i = 0; i < 20 && f.host.sent.length < 2; i++) await Promise.resolve()
    expect(f.host.references[1] ?? '').not.toContain('ORIGINAL_MAIL_BODY')
    expect(f.host.degrades[1]).toEqual([])
    f.journal.close()
  })

  it('sends a one-message reference (an old-page quote) beside your words', async () => {
    const f = setup()
    f.execution.send('那天说的桥在哪？', 'r-1', 'h-1', { recalledSeenReference: { quote: '周五桥在窗边' } })
    await f.opened()
    expect(JSON.parse(f.host.references[0]!)).toMatchObject({ recalledSeenReference: { quote: '周五桥在窗边' }, memoryReference: [{ text: '你喜欢用 TypeScript' }] })
    f.journal.close()
  })

  it('maps DSH turn errors to the book vocabulary with the HTTP status only', () => {
    const of = (code: string, message: string) => failureOf({ kind: 'error', error: { code, message } })
    expect(of('AUTH', '401 Unauthorized: VENDOR_BODY')).toEqual({ code: 'configuration-failed', httpStatus: 401 })
    expect(of('SERVER', '503 upstream overloaded')).toEqual({ code: 'upstream-busy', httpStatus: 503 })
    expect(of('RATE_LIMIT', '429 slow down')).toEqual({ code: 'upstream-busy', httpStatus: 429 })
    expect(of('QUOTA_EXCEEDED', 'insufficient balance')).toEqual({ code: 'quota-exhausted' })
    expect(of('INVALID_REQUEST', '400 {"error":{"code":"content_policy_violation"}}')).toEqual({ code: 'content-filtered', httpStatus: 400 })
    // A filter word in an error body is no verdict.
    expect(of('AUTH', '401 PRIVATE content filter body')).toEqual({ code: 'configuration-failed', httpStatus: 401 })
    expect(of('INVALID_REQUEST', '400 mentions a content filter')).toEqual({ code: 'configuration-failed', httpStatus: 400 })
    expect(of('TRANSPORT', 'stream ended without done')).toEqual({ code: 'stream-interrupted' })
    expect(of('TRANSPORT', 'ECONNREFUSED')).toEqual({ code: 'connection-failed' })
    expect(JSON.stringify(of('AUTH', '401 VENDOR_BODY'))).not.toContain('VENDOR_BODY')
  })

  it('keeps what she had said when the stream broke, marked as cut off, before the failure note', async () => {
    const f = setup()
    f.execution.send('讲个长故事', 'r-1', 'h-1')
    await f.opened()
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    f.emit({ t: 'delta', text: '从前有座山，' })
    f.emit({ t: 'delta', text: '山里有座庙' })
    f.emit({ t: 'turn-end', turn: 1, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'stream ended before done' } } })
    const messages = f.store.projection().messages
    expect(messages.at(-2)).toMatchObject({ role: 'assistant', text: '从前有座山，山里有座庙', status: 'interrupted' })
    expect(messages.at(-1)).toMatchObject({ role: 'narrator', failure: { code: 'stream-interrupted', category: 'interrupted' } })
    f.journal.close()
  })

  it('applies D-4 to DSH work turns and D2 to third-party turns in memory', async () => {
    const f = setup()
    f.execution.send('就用 TypeScript 写，别动 config 目录', 'r-1', 'h-1')
    await f.opened()
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    f.emit({ t: 'tool-call', callId: 'call-1', name: 'write', args: JSON.stringify({ file_path: 'a.ts', content: 'x' }) })
    f.emit({ t: 'tool-result', callId: 'call-1', isError: false })
    f.emit({ t: 'message', text: ['好，按你说的用 TypeScript，写在 `src/a.ts`：', '', '```ts', 'export const secretLooking = 42', '```', '', 'config 目录没动。'].join('\n'), toolCalls: [] })
    f.emit({ t: 'turn-end', turn: 1, reason: { kind: 'completed' } })
    // D-4: your decisions and reasons stay; her reply keeps its words without code or file excerpts.
    expect(seenFragments(f.store.records(), true).map((fragment) => fragment.text)).toEqual(['就用 TypeScript 写，别动 config 目录', ['好，按你说的用 TypeScript，写在 ：', 'config 目录没动。'].join('\n')])
    // D2: in a turn that read third-party content, only your own words become memory.
    f.execution.send('帮我查一下这个网页说了什么', 'r-2', 'h-2')
    f.emit({ t: 'turn-start', turn: 2, preset: 'workspace-write' })
    f.emit({ t: 'degraded', sources: ['web'] })
    f.emit({ t: 'message', text: '网页上说明天停课。', toolCalls: [] })
    f.emit({ t: 'turn-end', turn: 2, reason: { kind: 'completed' } })
    const memory = seenFragments(f.store.records(), true).map((fragment) => fragment.text)
    expect(memory).toContain('帮我查一下这个网页说了什么')
    expect(memory).not.toContain('网页上说明天停课。')
    f.journal.close()
  })

  it('asks per action without standing grants while third-party content is in context', async () => {
    const f = setup()
    f.execution.send('查一下资料再写', 'r-1', 'h-1')
    await f.opened()
    f.emit({ t: 'turn-start', turn: 1, preset: 'lca-trusted' })
    writeFileSync(join(f.root, 'dsh-approvals.json'), JSON.stringify([{ project: resolve(join(f.root, 'project')), tool: 'pwsh', prefix: null }]))
    expect(await f.approval({})).toBe('allowed-once')
    expect(f.asked).toHaveLength(0)
    f.emit({ t: 'degraded', sources: ['web'] })
    const turnId = (f.store.records().find((row) => row.type === 'turn/start') as { turnId: string }).turnId
    expect(f.store.projection().degraded).toMatchObject({ active: true, turnId, sources: ['web'] })
    expect(JSON.parse(readFileSync(join(f.root, 'dsh-sessions.json'), 'utf8'))[f.store.scope.sessionId][0]).toMatchObject({ id: 'dsh-1', degraded: ['web'] })
    expect(await f.approval({ kind: 'degraded', degraded: ['web'] })).toBe('allowed-once')
    expect(f.asked.at(-1)).toEqual({ question: '这一轮她读过网页，运行命令要先问你：node a.js。可以吗？', choices: ['允许这一次', '拒绝'] })
    f.setAnswer(() => '拒绝')
    expect(await f.approval({ kind: 'escalation', degraded: ['web'], reason: 'escalate sandbox to danger-full-access: needs to write outside' })).toBe('rejected')
    expect(f.asked.at(-1)?.choices).toEqual(['允许这一次', '拒绝'])
    expect(f.host.trusted).toEqual([])
    f.emit({ t: 'retired', count: 1 })
    expect(JSON.parse(readFileSync(join(f.root, 'dsh-sessions.json'), 'utf8'))[f.store.scope.sessionId][0].degraded).toBeUndefined()
    f.journal.close()
  })

  it('gives her your answer to her question as the tool result, and counts it among what she saw', async () => {
    const f = setup()
    f.execution.send('帮我记下来', 'r-1', 'h-1')
    await f.opened()
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    expect(await f.host.options!.onCall('lca_ask_user', {}, 'dsh-1', 'call-ask')).toEqual({ value: { status: 'answered', answer: '用 Markdown' }, source: null })
    const turnId = (f.store.records().find((row) => row.type === 'turn/start') as { turnId: string }).turnId
    expect(f.answeredCalls).toEqual([{ turnId, callId: 'call-ask' }])
    f.emit({ t: 'message', text: '好，记成 Markdown。', toolCalls: [] })
    f.emit({ t: 'turn-end', turn: 1, reason: { kind: 'completed' } })
    const seen = f.store.records().find((row) => row.type === 'model/seen')
    expect(seen?.type === 'model/seen' && seen.messages.map((message) => message.content)).toEqual(['帮我记下来', '用 Markdown', '好，记成 Markdown。'])
    f.journal.close()
  })

  it('records a project trust grant once DSH confirms it, and degrades turns fed by LCA source tools', async () => {
    const f = setup()
    f.execution.send('跑一下', 'r-1', 'h-1')
    await f.opened()
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    f.setAnswer(() => '这个项目以后都允许')
    expect(await f.approval({})).toBe('allowed-once')
    expect(f.host.trusted).toEqual(['dsh-1'])
    expect(f.store.records().some((row) => row.type === 'work/trust')).toBe(false)
    f.emit({ t: 'trusted', preset: 'lca-trusted' })
    expect(f.store.records().find((row) => row.type === 'work/trust')).toMatchObject({ sessionId: 'dsh-1', project: resolve(join(f.root, 'project')), preset: 'lca-trusted' })
    expect(await f.host.options!.onCall('lca_read_mail', {}, 'dsh-1', 'call-mail')).toEqual({ value: { subject: 'synthetic' }, source: 'mail' })
    // An uploaded original she asked for rides with the result as a document source; the journal never holds it.
    expect(await f.host.options!.onCall('lca_read_uploaded_file', {}, 'dsh-1', 'call-file')).toEqual({ value: { documentId: 'doc-1', sourceRead: true, original: 'UPLOADED_ORIGINAL' }, source: 'document' })
    expect(JSON.stringify(f.store.records())).not.toContain('UPLOADED_ORIGINAL')
    f.journal.close()
  })

  it('asks about trusting the project when the sandbox cannot run commands there', async () => {
    const f = setup()
    f.execution.send('跑一下', 'r-1', 'h-1')
    await f.opened()
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    f.setAnswer(() => '先不要')
    expect(await f.approval({ kind: 'trust', command: null, subject: 'node count.js' })).toBe('rejected')
    expect(f.asked.at(-1)).toEqual({ question: '她想在「project」里运行命令：node count.js，可这台电脑的系统沙箱在这个文件夹里用不了。要信任这个项目，让她像你一样在里面读写、运行命令吗？危险操作仍会先问你，LCA 的私有数据她不碰。', choices: ['信任这个项目', '先不要'] })
    f.setAnswer((choices) => choices[0])
    expect(await f.approval({ kind: 'trust', command: null, subject: 'node count.js' })).toBe('allowed-once')
    expect(JSON.parse(readFileSync(join(f.root, 'dsh-approvals.json'), 'utf8'))).toEqual([{ project: resolve(join(f.root, 'project')), tool: 'pwsh', prefix: null }])
    // The bridge applies the preset itself after LCA allows it, and reports back with `trusted`.
    expect(f.host.trusted).toEqual([])
    const asked = f.asked.length
    expect(await f.approval({ kind: 'trust', command: null, subject: null })).toBe('allowed-once')
    expect(await f.approval({ kind: 'trust', command: null, subject: null, degraded: ['web'] })).toBe('rejected')
    expect(f.asked).toHaveLength(asked)
    f.journal.close()
  })

  it('keeps a session degraded across a restart that came before retirement', async () => {
    const f = setup()
    f.execution.send('查资料', 'r-1', 'h-1')
    await f.opened()
    f.emit({ t: 'turn-start', turn: 1, preset: 'workspace-write' })
    f.emit({ t: 'degraded', sources: ['web'] })
    f.journal.close()
    const again = setup(f.root)
    again.execution.send('继续', 'r-2', 'h-2')
    await again.opened()
    expect(again.host.opened[0]?.[1]).toBe('dsh-1')
    expect(again.host.opened[0]?.[3]).toEqual(['web'])
    again.journal.close()
  })

  it('reads the single-session-per-day file written by 1.0.x', async () => {
    const f = setup()
    f.journal.close()
    const day = f.store.scope.sessionId
    writeFileSync(join(f.root, 'dsh-sessions.json'), JSON.stringify({ [day]: { id: 'dsh-old', cwd: join(f.root, 'project'), degraded: ['web'] } }))
    const again = setup(f.root)
    again.execution.send('继续', 'r-2', 'h-2')
    await again.opened()
    expect(again.host.opened[0]?.slice(1, 4)).toEqual(['dsh-old', false, ['web']])
    again.journal.close()
  })
})

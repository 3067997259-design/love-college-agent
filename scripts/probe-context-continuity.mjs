// Characterization probe for the 2026-10-19 context audit, not desired-behavior acceptance.
// HISTORICAL AFTER D2 (2026-10-19): the demo branch intentionally reverses several checks here
// (one timeline, fixed tools, defaults no longer attach originals). Keep this file as the dated audit
// record; current acceptance is `pnpm test:timeline-safety` plus `tests/unit/d2-safety.test.ts`.
// M1 (2026-10-19) now records provider cache usage; that single check verifies the implemented
// recording, while real provider cache hits remain unmeasured.
// Real context builders, harness and HTTP serializer; synthetic in-memory journal/desk/fetch only.
// The index.ts composition is mirrored below and guarded by source assertions; no Electron launch.
// No credentials, private profiles, network, model requests or production data are used.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (specifier.startsWith('.')) for (const suffix of ['.ts', '/index.ts']) {
        try { return next(specifier + suffix, context) } catch { /* Try the other TS module shape. */ }
      }
      throw error
    }
  },
  load(url, context, next) {
    if (url.endsWith('.json')) {
      const loaded = next(url, { ...context, importAttributes: { type: 'json' } })
      return { format: 'module', source: 'export default ' + Buffer.from(loaded.source).toString('utf8'), shortCircuit: true }
    }
    return next(url, context)
  },
})

const { createManualClock } = await import('../src/main/clock/index.ts')
const { createScheduler } = await import('../src/main/scheduler/index.ts')
const { inputSchema } = await import('../src/main/journal/schema.ts')
const { projectJournal } = await import('../src/main/journal/projection.ts')
const { projectMemory } = await import('../src/main/memory/projection.ts')
const { createMemoryService } = await import('../src/main/memory/service.ts')
const { seenFragments } = await import('../src/main/memory/seen.ts')
const { createHeartFlow } = await import('../src/main/heart-flow/service.ts')
const { createHarness } = await import('../src/main/harness/loop.ts')
const { createModelClient } = await import('../src/main/model/client.ts')

const observations = []
const check = (id, observed, expected) => {
  assert.deepEqual(observed, expected, id + ': current baseline changed; re-audit before interpreting')
  observations.push({ id, observed })
}
const text = (messages) => JSON.stringify(messages)
const hash = (messages) => createHash('sha256').update(text(messages)).digest('hex')
const signal = () => new AbortController().signal
const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
assert.ok(source.includes("['clock.read', 'plan.update', 'user.ask'].includes(tool.templateId) || tool.templateId.startsWith('desk')"))
assert.ok(source.includes('if (heartFlow?.active()) return []'))
assert.ok(source.includes("const insertion = Math.max(0, preparedContext.messages.findLastIndex((message) => message.role === 'user'))"))

function fixture() {
  const clock = createManualClock(Date.parse('2026-10-19T12:00:00+08:00'))
  const rows = []
  const scope = { userId: 'audit-user', characterId: 'audit-character', sessionId: 'audit-day' }
  const append = (input) => {
    const row = { ...inputSchema.parse(input), version: 1, seq: rows.length + 1, atMs: clock.nowMs() }
    rows.push(row)
    return row
  }
  append({ type: 'session/header', ...scope })
  const store = { scope, append, records: () => structuredClone(rows), history: () => structuredClone(rows),
    projection: () => projectJournal(rows), close() {} }
  const scheduler = createScheduler(clock)
  let flow
  let harness
  let world = 'AUDIT_WORLD_BEFORE'
  let prepareCount = 0
  const memory = createMemoryService({ clock, store, scheduler, repository: {
    view: () => projectMemory(rows), append, refresh() {}, close() {},
  }, model: null, isBusy: () => !!flow?.active(), changed() {}, rolled() {},
  includeContextEntries: (seqs) => flow?.normalEntriesAllowed(seqs) ?? new Set(seqs) })
  scheduler.cancel('memory.maintenance')
  const deskFiles = new Map()
  const desk = { read: (path) => deskFiles.get(path) ?? null, write: (path, value) => value === null ? deskFiles.delete(path) : deskFiles.set(path, value),
    list: () => [...deskFiles].map(([path, value]) => ({ path, byteLength: Buffer.byteLength(value) })), writeNew() {} }
  const normal = async (id, abort) => {
    prepareCount++
    const prepared = await memory.prepareContext(id, abort)
    // Mirrors the worldFacts insertion in main/index.ts; its exact source seam is asserted above.
    const facts = { role: 'user', content: JSON.stringify({ source: 'autonomous', worldFacts: { marker: world }, fictional: true, actualOfflineWork: false }) }
    const insertion = Math.max(0, prepared.messages.findLastIndex((message) => message.role === 'user'))
    return { messages: [...prepared.messages.slice(0, insertion), facts, ...prepared.messages.slice(insertion)],
      eligibleIndexes: [...prepared.eligibleIndexes.map((index) => index >= insertion ? index + 1 : index), insertion] }
  }
  const emitted = []
  flow = createHeartFlow({ store, clock, desk, booth: false, busy: () => harness?.isBusy() ?? false,
    changed() {}, prepare: normal, run: async () => 'synthetic',
    emit: (id, summary) => { emitted.push(summary); harness?.postEvent('autonomous', summary, id) } })
  const dispatch = (body) => flow.dispatch({ protocolVersion: 1, epoch: 'audit', requestId: 'audit', ...body })
  const chat = (user, assistant = 'AUDIT_CHAT_REPLY') => {
    const id = 'seed-' + rows.length
    const start = append({ type: 'user/message', id, text: user, requestId: id, commandHash: 'audit' })
    append({ type: 'turn/start', turnId: id, trigger: 'user' })
    append({ type: 'inbox/drain', ids: [id] })
    append({ type: 'assistant/message', turnId: id, id: id + '-reply', text: assistant, status: 'complete' })
    const end = append({ type: 'turn/end', turnId: id, reason: 'completed' })
    return { start: start.seq, end: end.seq }
  }
  const enter = async () => {
    assert.equal(dispatch({ type: 'flow.enter' }), undefined)
    for (let i = 0; i < 20 && !flow.active(); i++) await Promise.resolve()
    assert.ok(flow.active(), 'synthetic flow must open')
  }
  return { clock, rows, store, memory, flow, dispatch, chat, enter, normal, emitted,
    setWorld: (value) => { world = value }, getPrepareCount: () => prepareCount,
    attach: (value) => { harness = value },
    close: async () => { await harness?.dispose(); flow.close(); await memory.close(); scheduler.dispose() } }
}

const f = fixture()
try {
  f.store.append({ type: 'context/inject', source: 'policy', text: 'AUDIT_PERSONA_RULE' })
  const old = f.chat('AUDIT_COMPACTED_SOURCE')
  f.store.append({ type: 'context/compact', fromSeq: old.start, toSeq: old.end,
    summary: JSON.stringify({ conversationSummary: 'AUDIT_DAY_COMPACT', reviewStatus: 'unreviewed' }) })
  f.store.append({ type: 'memory/summary', summary: { id: 'audit-previous-summary', level: 'day', period: '2026-10-18',
    text: 'AUDIT_PREVIOUS_DAY', sources: [], sourceSessionIds: ['audit-yesterday'], source: 'fake' } })
  for (let i = 0; i < 10; i++) f.chat(i === 0 ? 'AUDIT_EARLY_REQUIREMENT' : 'AUDIT_CHAT_' + i)
  f.chat('x'.repeat(510) + 'AUDIT_LONG_MESSAGE_TAIL')
  const normal = await f.normal('before', signal())
  check('normal-has-daily-compaction', text(normal.messages).includes('AUDIT_DAY_COMPACT'), true)
  check('normal-has-early-requirement', text(normal.messages).includes('AUDIT_EARLY_REQUIREMENT'), true)
  check('normal-has-previous-day', text(normal.messages).includes('AUDIT_PREVIOUS_DAY'), true)
  check('normal-has-world', text(normal.messages).includes('AUDIT_WORLD_BEFORE'), true)
  await f.enter()
  const entry = await f.flow.prepareContext('entry', signal())
  const entryText = text(entry.messages)
  check('work-retains-persona', entryText.includes('AUDIT_PERSONA_RULE'), true)
  check('work-retains-system-compaction', entryText.includes('AUDIT_DAY_COMPACT'), true)
  check('work-loses-early-uncompacted-requirement', entryText.includes('AUDIT_EARLY_REQUIREMENT'), false)
  check('work-truncates-long-chat-reference', entryText.includes('AUDIT_LONG_MESSAGE_TAIL'), false)
  check('work-loses-previous-day-reference', entryText.includes('AUDIT_PREVIOUS_DAY'), false)
  check('work-loses-world-at-entry', entryText.includes('AUDIT_WORLD_BEFORE'), false)

  const requests = []
  const replies = [
    { text: 'AUDIT_WORK_MODEL_PLAN', calls: [{ index: 0, id: 'audit-clock-call', type: 'function', function: { name: 'audit_clock', arguments: '{}' } }] },
    { text: 'AUDIT_WORK_ASSISTANT_DONE' }, { text: 'AUDIT_CHAT_RETURNED' },
  ]
  // A fake fetcher executes the real request serializer and SSE parser. The sentinel is synthetic.
  const client = createModelClient(new Map([['chat', { base_url: 'https://audit.invalid/v1', model: 'synthetic-model', api_key: 'synthetic-key' }]]), ['chat'], f.clock,
    async (_url, init) => {
      requests.push(JSON.parse(init.body))
      const reply = replies.shift(); assert.ok(reply, 'unexpected additional model request')
      const chunk = { choices: [{ index: 0, finish_reason: reply.calls ? 'tool_calls' : 'stop', delta: { content: reply.text, ...(reply.calls ? { tool_calls: reply.calls } : {}) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 800, prompt_tokens_details: { cached_tokens: 800 } } }
      return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { status: 200 })
    })
  const attempts = []
  const tools = ['clock.read', 'plan.update', 'user.ask', 'desk.read', 'pomodoro.get_timer', 'memory.search', 'campus.confirm'].map((templateId, index) => ({
    templateId, definition: { name: index === 0 ? 'audit_clock' : 'audit_tool_' + index, description: 'Synthetic audit tool', parameters: { type: 'object', properties: {} } },
    validate: () => true, run: async () => {
      f.setWorld('AUDIT_WORLD_CHANGED')
      harness.postEvent('autonomous', 'AUDIT_WORLD_EVENT', 'audit-world-event')
      harness.postEvent('pomodoro', 'AUDIT_TIMER_EVENT', 'audit-timer-event')
      return { ok: true, visible: { observed: 'synthetic' }, raw: { observed: 'synthetic' } }
    },
  }))
  const harness = createHarness({ store: f.store, clock: f.clock,
    model: { source: client.source, complete: (request, onAttempt) => client.complete(request, (attempt) => { attempts.push(attempt); onAttempt(attempt) }) }, tools: [],
    // Mirrors main/index.ts tool selection and quiet-event gate; source seam asserted above.
    getTools: () => f.flow.active() ? tools.filter((tool) => ['clock.read', 'plan.update', 'user.ask'].includes(tool.templateId) || tool.templateId.startsWith('desk')) : tools,
    backgroundQuiet: () => f.flow.active(), prepareContext: (id, abort) => f.flow.prepareContext(id, abort) })
  f.attach(harness)
  harness.send('AUDIT_WORK_USER_DECISION', 'audit-send', 'audit')
  await harness.idle()
  check('work-completes-two-real-harness-sampling-steps', requests.length, 2)
  check('work-frozen-prefix-stable', hash(requests[0].messages.slice(0, entry.messages.length)) === hash(requests[1].messages.slice(0, entry.messages.length)), true)
  check('work-never-refreshes-normal-context', f.getPrepareCount(), 2)
  check('work-hides-world-and-timer-events', /AUDIT_WORLD_EVENT|AUDIT_TIMER_EVENT|AUDIT_WORLD_CHANGED/.test(text(requests[1].messages)), false)
  check('work-has-no-timer-or-memory-or-campus-tools', requests[1].tools.some((tool) => /audit_tool_[456]/.test(tool.function.name)), false)
  check('work-inputs-ineligible-for-experience-extraction', f.rows.filter((row) => row.type === 'model/seen').every((row) => row.eligibleIndexes.length === 0), true)
  // Synthetic usage carries prompt_cache_hit_tokens (800) and prompt_tokens_details.cached_tokens (800),
  // so the missing DeepSeek miss field must be derived as 1000 - 800.
  check('synthetic-cache-usage-recorded-by-parser', attempts.some((attempt) => attempt.status === 'success' && attempt.cachedInputTokens === 800 && attempt.uncachedInputTokens === 200)
    && f.rows.some((row) => row.type === 'model/attempt' && row.status === 'success' && row.cachedInputTokens === 800 && row.uncachedInputTokens === 200), true)
  check('work-user-visible-while-active', f.flow.messages().some((message) => message.text.includes('AUDIT_WORK_USER_DECISION')), true)
  assert.equal(f.dispatch({ type: 'flow.exit' }), undefined)
  await harness.idle()
  check('return-to-chat-samples-after-exit', requests.length, 3)
  check('return-to-chat-receives-queued-events', text(requests[2].messages).includes('AUDIT_TIMER_EVENT') && text(requests[2].messages).includes('AUDIT_WORLD_EVENT'), true)
  check('return-to-chat-refreshes-world', text(requests[2].messages).includes('AUDIT_WORLD_CHANGED'), true)
  check('return-to-chat-loses-work-conversation', /AUDIT_WORK_USER_DECISION|AUDIT_WORK_MODEL_PLAN|AUDIT_WORK_ASSISTANT_DONE/.test(text(requests[2].messages)), false)
  check('return-summary-only-evidence-not-work-discussion', f.emitted[0].includes('heartFlowFinished') && !f.emitted[0].includes('AUDIT_WORK_USER_DECISION'), true)
  check('return-ui-hides-work-conversation', f.flow.messages().some((message) => message.text.includes('AUDIT_WORK_USER_DECISION')), false)
  check('memory-surface-has-no-work-user-decision', seenFragments(f.rows, true).some((fragment) => fragment.text.includes('AUDIT_WORK_USER_DECISION')), false)
} finally { await f.close() }

const r = fixture()
try {
  r.store.append({ type: 'context/inject', source: 'policy', text: 'AUDIT_ORIGINAL_POLICY' })
  r.chat('AUDIT_ENTRY_CHAT')
  await r.enter()
  const firstId = r.flow.id()
  r.chat('AUDIT_WORK_REASON', 'AUDIT_WORK_CHOICE')
  const beforeGoal = await r.flow.prepareContext('before-goal', signal())
  check('work-has-discussion-before-manual-compact', text(beforeGoal.messages).includes('AUDIT_WORK_REASON'), true)
  assert.equal(r.dispatch({ type: 'flow.goal.set', text: 'AUDIT_CHANGED_GOAL' }), undefined)
  const afterGoal = await r.flow.prepareContext('after-goal', signal())
  check('goal-change-inserts-before-prior-work-history', text(afterGoal.messages).indexOf('AUDIT_CHANGED_GOAL') < text(afterGoal.messages).indexOf('AUDIT_WORK_REASON'), true)
  check('goal-change-breaks-whole-request-append-only-property', hash(afterGoal.messages.slice(0, beforeGoal.messages.length)) === hash(beforeGoal.messages), false)
  assert.equal(r.dispatch({ type: 'flow.compact' }), undefined)
  check('manual-work-compaction-loses-reason-and-choice', /AUDIT_WORK_REASON|AUDIT_WORK_CHOICE/.test(text((await r.flow.prepareContext('after-compact', signal())).messages)), false)
  assert.equal(r.dispatch({ type: 'flow.exit' }), undefined)
  check('normal-context-filters-prior-work-discussion', text((await r.normal('normal-filter', signal())).messages).includes('AUDIT_WORK_REASON'), false)
  await r.enter()
  check('new-work-entry-reimports-prior-hidden-work-from-ui', text((await r.flow.prepareContext('new-entry', signal())).messages).includes('AUDIT_WORK_REASON'), true)
  assert.equal(r.dispatch({ type: 'flow.exit' }), undefined)
  r.store.append({ type: 'context/inject', source: 'policy', text: 'AUDIT_UPDATED_POLICY' })
  r.chat('AUDIT_CHAT_AFTER_WORK')
  const beforeResume = r.getPrepareCount()
  assert.equal(r.dispatch({ type: 'flow.resume', flowId: firstId }), undefined)
  check('resume-reuses-old-prefix-without-normal-prepare', r.getPrepareCount(), beforeResume)
  check('resume-does-not-see-current-chat-or-updated-policy', /AUDIT_UPDATED_POLICY|AUDIT_CHAT_AFTER_WORK/.test(text((await r.flow.prepareContext('resumed', signal())).messages)), false)
} finally { await r.close() }

const report = { baseline: 'b4b3d9cd2e986ea4925beef4ccb27b1f79da1d0a',
  scope: 'synthetic characterization, not desired continuity acceptance; provider cache fields are now recorded (M1), real cache hits remain unmeasured',
  adapters: ['in-memory journal and desk', 'index.ts composition mirror with source assertions', 'fake fetch; real serializer/parser; no HTTP requests'], observations }
const folder = new URL('../test-results/', import.meta.url)
mkdirSync(folder, { recursive: true })
const output = new URL('context-continuity-audit-20261019.json', folder)
writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ observedChecks: observations.length, output: fileURLToPath(output), acceptance: 'current behavior reproduced; continuity gaps remain' }))

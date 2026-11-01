import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createManualClock, systemClock } from '../../src/main/clock'
import { createScheduler } from '../../src/main/scheduler'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import { createMemoryFacts } from '../../src/main/memory/facts'
import { createMemoryService } from '../../src/main/memory/service'
import { createFakeMemoryModel } from '../../src/main/memory/model'
import { projectMemory } from '../../src/main/memory/projection'
import { createMemoryDatabaseClient } from '../../src/main/memory/storage/client'
import { createNativeMemoryDatabase } from '../../src/main/memory/storage/neo'
import { memoryTools } from '../../src/main/memory/tools'
import { createDshExecution } from '../../src/main/dsh/execution'
import { dshRoutes } from '../../src/main/dsh/routes'
import { createAppController } from '../../src/main/bridge/controller'
import type { AppCommand } from '../../src/shared'

const root = resolve(process.argv[2]); const repo = resolve(process.argv[3])
const clock = createManualClock(1_790_000_000_000)
const scheduler = createScheduler(clock)
const journal = openJournal(root, { userId: 'synthetic-user', characterId: 'synthetic-character' }, clock)
const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
const controller = createAppController(clock, undefined, store)
const captured: string[] = []; const requests: { phase: string; model: string; current: string }[] = []
let phase = 'remember'; let summaryCalls = 0; let target: { id: string; revision: number } | undefined
let settled: (() => void) | undefined; let completed = 0; let failure: unknown
const textOf = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part.text ?? '').join('') : ''
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions')
      const input = JSON.parse(body)
      const messages = input.messages as { role: string; content: unknown; tool_call_id?: string }[]
      const mark = messages.findLastIndex(message => message.role === 'user' && /\[\[(?:REMEMBER|RECALL|CORRECT|AFTER)\]\]/.test(textOf(message.content)))
      const current = textOf(messages[mark]?.content)
      requests.push({ phase, model: input.model, current: current.slice(0, 4000) })
      const lastTool = messages.slice(mark + 1).findLast(message => message.role === 'tool')
      let reply: { text?: string; tool?: string; args?: unknown }
      if (phase === 'compact') { summaryCalls++; reply = { text: 'The user first preferred tea, then explicitly corrected the preference to coffee. Current memory revisions must be read from the next turn reference.' } }
      else if (phase === 'remember' && !lastTool) reply = { tool: 'lca_remember_memory', args: { content: 'PREFERENCE_TEA', title: 'Drink', summary: 'The current drink is tea.' } }
      else if (phase === 'correct' && !lastTool) {
        assert.ok(target && current.includes(target.id))
        reply = { tool: 'lca_correct_memory', args: { targetId: target.id, expectedRevision: target.revision, content: 'PREFERENCE_COFFEE', title: 'Drink', summary: 'The current drink is coffee.' } }
      } else {
        if (phase === 'recall') assert.ok(current.includes('PREFERENCE_TEA'), 'APPROVED_FACT_WAS_NOT_INJECTED')
        if (phase === 'after') {
          assert.ok(current.includes('PREFERENCE_COFFEE'), 'CORRECTED_FACT_WAS_NOT_INJECTED')
          assert.ok(!current.includes('PREFERENCE_TEA'), 'STALE_CURRENT_REFERENCE')
        }
        reply = { text: phase === 'remember' || phase === 'correct' ? 'The proposal is waiting for your review.' : 'DERIVED_MEMORY_REPLY ' + (phase === 'after' ? 'PREFERENCE_COFFEE' : 'PREFERENCE_TEA') }
      }
      if (reply.tool) assert.ok(input.tools.some((tool: { function: { name: string } }) => tool.function.name === reply.tool), 'NORMAL_TOOL_NOT_AVAILABLE')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: `local-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      send(reply.tool ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call-${phase}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : { role: 'assistant', content: reply.text })
      send({}, reply.tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n')
    } catch (error) { failure = error; res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'SCRIPTED_CONTRACT_FAILED' } })) }
  })
})

async function run() {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const provider = { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'synthetic-local-only', model: 'memory-script', capabilities: { contextWindow: 131072, maxOutputTokens: 8192 } }
  const facts = createMemoryFacts({ root: join(root, 'facts'), clock, store, owner: { ...store.scope, dataRootId: root }, held: () => false, waitForRestore: async () => {}, changed: () => controller.refresh('connection'),
    embedding: () => ({ provider: 'fixture', model: 'synthetic-768', fingerprint: 'memory-short-loop-768', embed: async () => Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) }),
    openDatabase: async path => { const db = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock); await db.open(path); return db } })
  const model = createFakeMemoryModel().model
  model.airi = { extract: async input => { captured.push(input.userText || input.assistantText); return [] } }
  const memory = createMemoryService({ clock, store, scheduler, facts, repository: { view: () => projectMemory(store.records()), append: store.append, refresh: () => {}, close: () => {} }, model,
    isBusy: () => execution.busy(), rolled: () => {}, changed: () => controller.refresh('task'), compactRoot: operationId => execution.compact(operationId) })
  scheduler.cancel('memory.maintenance')
  const project = join(root, 'project'); mkdirSync(project, { recursive: true })
  const execution = createDshExecution({ store, clock, processClock: systemClock, dataDir: root, dshRoot: join(repo, 'dsh/runtime'), bridge: join(repo, 'dsh/lca-bridge'), guardedRoots: [join(root, 'facts')],
    routes: dshRoutes(provider, provider, {}), source: 'fake', project: () => project, persona: () => 'You are a scripted memory acceptance agent.', suffix: () => '', tools: () => memoryTools(memory),
    ask: async () => null, changed: reason => controller.refresh(reason), foreground: memory.foreground,
    reference: ({ requestId, firstOfSession }) => memory.reference('current drink preference', requestId, firstOfSession),
    referencesPrepared: (requestId, reference) => memory.disclose(requestId, reference),
    started: ({ requestId, turnId }) => memory.bind(requestId, turnId), settled: () => { completed++; settled?.(); settled = undefined } })
  controller.attachMemory(memory); controller.attachExecution(execution, true)
  const dispatch = (body: Record<string, unknown>) => controller.dispatch({ protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: randomUUID(), ...body } as AppCommand)
  const chat = async (text: string) => {
    const done = new Promise<void>(resolve => { settled = resolve })
    const ack = dispatch({ type: 'message.send', text }); assert.equal(ack.status, 'accepted', JSON.stringify(ack))
    await execution.prepared(); await done
    if (failure) throw failure
    assert.equal(store.projection().task?.status, 'completed')
  }
  const review = async () => {
    const operation = memory.view().operations?.findLast(item => item.status === 'pending_review')
    assert.ok(operation)
    assert.equal(dispatch({ type: 'memory.review', operationId: operation.operationId, approve: true }).status, 'accepted')
    await memory.idle(); assert.equal(memory.view().operations?.find(item => item.operationId === operation.operationId)?.status, 'applied')
  }
  try {
    await memory.initialize()
    await chat('[[REMEMBER]] Please remember my drink preference is PREFERENCE_TEA. ' + 'An ordinary conversation detail. '.repeat(450))
    assert.equal((await facts.search('drink', 'pending-check')).length, 0)
    assert.ok(memory.view().operations?.some(item => item.status === 'pending_review'))
    await review()
    phase = 'recall'; await chat('[[RECALL]] What is my drink preference? ' + 'A harmless second historical detail. '.repeat(300))
    target = facts.factViews().find(item => item.content === 'PREFERENCE_TEA')
    assert.ok(target)
    phase = 'correct'; await chat('[[CORRECT]] Change my drink preference to PREFERENCE_COFFEE.')
    await review()
    assert.equal(facts.factViews().find(item => item.id === target!.id)?.factStatus, 'superseded')
    phase = 'compact'
    const historyBefore = store.records().filter(row => row.type === 'user/message' || row.type === 'assistant/message')
    assert.equal(dispatch({ type: 'context.compact' }).status, 'accepted'); await memory.idle()
    assert.equal(memory.view().compaction?.outcome, 'compacted'); assert.equal(summaryCalls, 1)
    assert.deepEqual(store.records().filter(row => row.type === 'user/message' || row.type === 'assistant/message'), historyBefore)
    phase = 'after'; await chat('[[AFTER]] What is my current drink preference after that correction?')
    const old = await facts.read('old-read', 'synthetic-source', [{ id: target.id, offset: 0 }], new AbortController().signal)
    assert.equal(old.results[0]?.status, 'unavailable_or_changed')
    assert.equal(dispatch({ type: 'memory.extract' }).status, 'accepted'); await memory.idle()
    assert.ok(captured.length > 0); assert.ok(captured.every(text => !text.includes('DERIVED_MEMORY_REPLY')))
    assert.equal(store.records().filter(row => row.type === 'memory/batch').length, 0)
    return { ok: true, completedTurns: completed, modelRequests: requests.length, summaryCalls,
      checks: { normalDshMemoryTools: true, pendingReviewNotRecalled: true, reviewedPreferenceRecalled: true, correctionSupersedesOldValue: true,
        actualDshCompaction: true, correctedValueAfterCompaction: true, staleReadRejected: true, derivedRepliesNotRecaptured: true, noLegacyFactWrites: true, originalConversationPreserved: true } }
  } finally { await execution.close(); await memory.close(); scheduler.dispose(); controller.dispose(); store.close() }
}

void run().then(report => { writeFileSync(join(root, 'report.json'), JSON.stringify({ ...report, requests }, null, 2)); process.exitCode = 0 }, error => {
  writeFileSync(join(root, 'report.json'), JSON.stringify({ ok: false, phase, error: String(error), stack: error instanceof Error ? error.stack : undefined, requests }, null, 2)); process.exitCode = 1
}).finally(() => { server.closeAllConnections(); server.close() })

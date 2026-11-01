import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createManualClock, systemClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import type { SessionStore } from '../../src/main/store/session'
import { createDshExecution } from '../../src/main/dsh/execution'
import { createRootHost } from '../../src/main/dsh/root-host'
import { dshRoutes } from '../../src/main/dsh/routes'
import { createAppController } from '../../src/main/bridge/controller'
import { createContinuousWork, type WorkRuntimeContext } from '../../src/main/work/service'
import { openWorkStore } from '../../src/main/work/store'
import { workTools, workCompletionTools, checkpointContext } from '../../src/main/work/tools'
import { workExperience } from '../../src/main/work/experience'
import { seenFragments } from '../../src/main/memory/seen'
import type { WorkRecord } from '../../src/main/work/journal'
import type { HarnessTool } from '../../src/main/harness/tools'
import type { AppCommand } from '../../src/shared'
import type { WorkTarget } from '../../src/shared/continuity'

const root = resolve(process.argv[2]), repo = resolve(process.argv[3])
const clock = createManualClock(1_790_000_000_000)
const journal = openJournal(root, { userId: 'fixture-user', characterId: 'fixture-character' }, clock)
const store: SessionStore = { scope: journal.scope, records: journal.records, history: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
const owner = { userId: store.scope.userId, characterId: store.scope.characterId, dataRootId: 'fixture' }
const controller = createAppController(clock, undefined, store)
const requests: { model: string; root: string; phase: string; text: string }[] = []
const checks: Record<string, boolean> = {}
let phase = 'start', failure: unknown, heldResponse: { response: ServerResponse; model: string } | undefined
let effectCalls = 0, recordCalls = 0, frontEnded: (() => void) | undefined, workEnded: (() => void) | undefined
let storyStep = 0, storyWork: (() => WorkRecord) | undefined
const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const holdA = barrier(), holdB = barrier(), releaseA = barrier(), abortedB = barrier(), staleRequest = barrier()
const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => block.text ?? '').join('') : ''
function answer(response: ServerResponse, model: string, reply: { text?: string; tool?: string; args?: unknown }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  chunk(reply.tool ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }] } : { role: 'assistant', content: reply.text }, null)
  chunk({}, reply.tool ? 'tool_calls' : 'stop'); response.end('data: [DONE]\n\n')
}
const server = createServer((request, response) => {
  let body = ''; request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    try {
      const input = JSON.parse(body), messages = input.messages as { role: string; content: unknown; name?: string }[]
      const text = messages.map(message => textOf(message.content)).join('\n')
      const role = input.model === 'work-script' ? text.includes('[[WORK_B]]') ? 'B' : 'A' : 'foreground'
      requests.push({ model: input.model, root: role, phase, text })
      writeFileSync(join(root, 'synthetic-requests.json'), JSON.stringify(requests, null, 2))
      const tools = messages.filter(message => message.role === 'tool')
      if (phase.startsWith('story-')) {
        const work = storyWork!()
        if (role !== 'foreground') {
          assert.ok(text.includes('NEWEST_VALUE'), 'LATEST_DECISION_MISSING_FROM_RESUME')
          if (storyStep++ === 0) { answer(response, input.model, { tool: 'write', args: { file_path: 'output.txt', content: 'NEWEST_VALUE\n' } }); return }
          if (storyStep === 2) { answer(response, input.model, { tool: 'lca_inspect_current_work' }); return }
          const proof = work.evidence?.find(item => item.identity.generation === work.identity.generation && item.kind === 'artifact' && item.status === 'passed')
          assert.ok(proof && text.includes(proof.id), 'EXECUTOR_PROOF_NOT_IN_MODEL_INPUT')
          if (storyStep === 3) { answer(response, input.model, { tool: 'lca_finish_work', args: { expectedObjectiveRevision: work.identity.objectiveRevision,
            evidenceIds: [proof.id], outcome: 'completed', explanation: 'Wrote NEWEST_VALUE to output.txt.', unresolved: [], nextStep: null } }); return }
          assert.equal(work.status, 'running', 'PREPARED_CHECKPOINT_PUBLISHED_TOO_EARLY')
          answer(response, input.model, { text: 'Checkpoint prepared with actual file evidence.' }); return
        }
        const checkpoint = checkpointContext(work)
        assert.ok(checkpoint?.published && text.includes(checkpoint.observations[0].hash!), 'FRONT_MISSING_PUBLISHED_CHECKPOINT')
        answer(response, input.model, { text: 'Delivered output.txt with NEWEST_VALUE and a verified hash.' }); return
      }
      if (role !== 'foreground') {
        assert.ok(text.includes(`[[WORK_${role}]]`), 'WORK_PACKAGE_MISSING')
        assert.ok(!text.includes(`[[WORK_${role === 'A' ? 'B' : 'A'}]]`), 'CROSS_ROOT_PACKAGE')
        if (!tools.length) { answer(response, input.model, { tool: 'lca_gate_hold', args: { root: role } }); return }
        if (role === 'B') throw new Error('STOPPED_ROOT_CONTINUED')
        if (recordCalls === 0) {
          assert.ok(text.includes('NEW_VALUE'), 'SUPPLEMENT_NOT_IN_SAME_ROOT')
          answer(response, input.model, { tool: 'lca_gate_record' }); return
        }
        if (!text.includes('NEWEST_VALUE') && phase !== 'stale-action') { heldResponse = { response, model: input.model }; staleRequest.resolve(); return }
        assert.ok(text.includes('NEWEST_VALUE'), 'LATEST_UPDATE_NOT_IN_NEXT_REQUEST')
        assert.ok(text.includes('The user changed this work'), 'OLD_ACTION_NOT_REJECTED')
        answer(response, input.model, { text: 'Used NEWEST_VALUE; the superseded action did not run.' }); return
      }
      const index = messages.findLastIndex(message => message.role === 'user' && /\[\[(START_[AB]|CHAT|UPDATE_[AB])\]\]/.test(textOf(message.content)))
      const current = textOf(messages[index]?.content)
      const currentMarker = [...current.matchAll(/\[\[(START_[AB]|CHAT|UPDATE_[AB])\]\]/g)].at(-1)?.[1]
      const alreadyCalled = messages.slice(index + 1).some(message => message.role === 'tool')
      if (currentMarker?.startsWith('START_') && !alreadyCalled) {
        const label = currentMarker === 'START_B' ? 'B' : 'A'
        answer(response, input.model, { tool: 'lca_start_work', args: { objective: `[[WORK_${label}]]`, acceptance: ['Report actual fixture evidence.'] } }); return
      }
      answer(response, input.model, { text: 'Foreground conversation completed.' })
    } catch (error) { failure = error; response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'SCRIPTED_CONTRACT_FAILED' } })) }
  })
})

async function run() {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const provider = { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'local-fixture', capabilities: { contextWindow: 131072, maxOutputTokens: 8192 } }
  const routes = dshRoutes({ ...provider, model: 'chat-script' }, { ...provider, model: 'work-script' }, {})
  const projects = { A: join(root, 'project-a'), B: join(root, 'project-b') }; for (const path of Object.values(projects)) mkdirSync(path, { recursive: true })
  let selected: 'A' | 'B' = 'A'
  const host = createRootHost({ dataDir: root })
  const experience = workExperience(store, () => 'fake')
  const result = (value: string) => ({ ok: true, raw: { value }, visible: { value } })
  const fixtureTools: HarnessTool[] = [
    { templateId: 'fixture.hold', definition: { name: 'gate_hold', description: 'Wait on an isolated deterministic test barrier.', parameters: { type: 'object', properties: { root: { type: 'string', enum: ['A', 'B'] } }, required: ['root'], additionalProperties: false } }, validate: input => input.root === 'A' || input.root === 'B',
      run: async (input, context) => {
        if (input.root === 'A') { holdA.resolve(); await releaseA.promise; context.signal.throwIfAborted(); return result('A_RELEASED') }
        holdB.resolve(); await new Promise<void>((_resolve, reject) => { const aborted = () => { abortedB.resolve(); reject(new Error('ABORTED_B')) }; if (context.signal.aborted) aborted(); else context.signal.addEventListener('abort', aborted, { once: true }) }); return result('UNREACHABLE')
      } },
    { templateId: 'fixture.record', definition: { name: 'gate_record', description: 'Record an actual fixture receipt.', parameters: { type: 'object', properties: {}, additionalProperties: false } }, validate: () => true,
      run: async () => { recordCalls++; writeFileSync(join(projects.A, 'receipt.txt'), 'NEW_VALUE'); return result('RECORDED') } },
    { templateId: 'fixture.effect', definition: { name: 'gate_effect', description: 'An action from a superseded model step.', parameters: { type: 'object', properties: {}, additionalProperties: false } }, validate: () => true,
      run: async () => { effectCalls++; return result('MUST_NOT_RUN') } },
  ]
  const common = { clock, processClock: systemClock, dshRoot: join(repo, 'dsh/runtime'), bridge: join(repo, 'dsh/lca-bridge'), guardedRoots: [join(root, 'continuous-work')],
    routes, source: 'fake' as const, launch: host.launch, persona: () => 'A scripted continuous collaborator.', suffix: () => '', ask: async () => null, admit: () => null }
  const service = createContinuousWork({ root: join(root, 'continuous-work'), owner, clock, available: () => true, held: () => false, safeText: text => text,
    project: id => { const key = id === 'current' ? selected : id; return key === 'A' || key === 'B' ? { id: key, path: projects[key] } : null },
    decision: id => { const row = store.records().find(row => row.type === 'user/message' && row.id === id); return row?.type === 'user/message' ? { id, text: row.text, atMs: row.atMs } : null },
    observed: experience.observed,
    deliverCheckpoint: (work, checkpoint) => experience.deliver(work, checkpoint, (text, eventId) => foreground.postEvent('work', text, eventId)),
    createRuntime: (context: WorkRuntimeContext) => {
      const path = join(root, 'continuous-work', context.work.identity.workId, String(context.work.identity.generation)); mkdirSync(path, { recursive: true })
      const privateStore = openWorkStore(path, owner, clock, context.work.runStartedAt, store)
      const execution = createDshExecution({ ...common, store: privateStore, dataDir: path, project: () => context.work.projectPath, tools: () => [...fixtureTools, ...workCompletionTools(service, context.work.identity)],
        rootPolicy: { role: 'worker', work: context.work.identity }, consumed: context.consumed, evidence: context.evidence, successfulInputs: context.successfulInputs,
        changed: () => {}, settled: () => { const end = privateStore.records().findLast(row => row.type === 'turn/end'); context.settled(end?.type === 'turn/end' && end.reason === 'error'); workEnded?.() } })
      return { ...execution, close: async () => { await execution.close(); privateStore.close() } }
    }, changed: () => controller.refresh('task') })
  const foreground = createDshExecution({ ...common, store, dataDir: root, project: () => projects[selected], rootPolicy: { role: 'foreground', work: null },
    consumed: id => { experience.consumed(id); service.consumedDelivery(id) },
    reference: () => ({ workCheckpoints: service.view().items.map(item => ({ identity: item.identity, revision: item.revision, label: item.label, status: item.status,
      checkpoint: checkpointContext(service.get(item.identity.workId)!) })) }),
    tools: () => workTools(service), changed: reason => controller.refresh(reason), settled: () => { frontEnded?.(); frontEnded = undefined } })
  controller.attachExecution(foreground, true); controller.attachContinuousWork(service)
  const send = (body: Record<string, unknown>, requestId = randomUUID()) => controller.dispatch({ protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId, ...body } as AppCommand)
  const chat = async (text: string) => { const done = new Promise<void>(resolve => { frontEnded = resolve }); assert.equal(send({ type: 'message.send', text }).status, 'accepted'); await foreground.prepared(); await done; if (failure) throw failure; assert.equal(store.projection().task?.status, 'completed') }
  const target = (id: string): WorkTarget => { const work = service.view().items.find(work => work.identity.workId === id)!; return { identity: work.identity, expectedRevision: work.revision } }
  const source = () => { const row = store.records().findLast(row => row.type === 'user/message'); assert.ok(row?.type === 'user/message'); return row }
  const until = (condition: () => boolean) => new Promise<void>(done => { const stop = controller.subscribe(() => { if (condition()) { stop(); done() } }); if (condition()) { stop(); done() } })
  const steps = async () => {
    await chat('[[START_A]] Please start task A.'); await holdA.promise
    const a = service.view().items.find(work => work.identity.projectId === 'A')!.identity.workId
    phase = 'chat-while-held'; await chat('[[CHAT]] How is your day?')
    checks.foregroundCompletesWhileToolHeld = service.get(a)?.status === 'running'
    await chat('[[UPDATE_A]] For task A use NEW_VALUE.'); const decision = source()
    const update = { type: 'work.supplement', target: target(a), text: decision.text, decisionId: decision.id }
    assert.equal(send(update, 'update-a').status, 'accepted'); assert.equal(send(update, 'update-a').status, 'accepted')
    selected = 'B'; await chat('[[START_B]] Please start task B.'); await holdB.promise
    const b = service.view().items.find(work => work.identity.projectId === 'B')!.identity.workId
    checks.twoWorkerRoots = service.view().active === 2
    phase = 'updated-worker'; releaseA.resolve(); await staleRequest.promise
    checks.supplementReachedOriginalRoot = recordCalls === 1
    checks.duplicateEventNotExecuted = service.get(a)?.inputs.filter(input => input.kind === 'supplement').length === 1
    phase = 'stop-b'; assert.equal(send({ type: 'work.stop', target: target(b) }).status, 'accepted'); await abortedB.promise
    checks.stopDoesNotCancelOtherRoot = service.get(a)?.status === 'running'
    await chat('[[UPDATE_A]] For task A use NEWEST_VALUE.'); const newest = source()
    assert.equal(send({ type: 'work.supplement', target: target(a), text: newest.text, decisionId: newest.id }).status, 'accepted')
    // Wait for preparation/accepted receipt through a state-change condition, not a fixed sleep.
    await new Promise<void>(done => { const stop = controller.subscribe(() => { if (service.get(a)?.inputs.at(-1)?.state === 'accepted') { stop(); done() } }); if (service.get(a)?.inputs.at(-1)?.state === 'accepted') { stop(); done() } })
    phase = 'stale-action'; const ended = new Promise<void>(done => { workEnded = done })
    assert.ok(heldResponse); answer(heldResponse.response, heldResponse.model, { tool: 'lca_gate_effect' }); await ended
    if (failure) throw failure
    checks.oldUnissuedActionRejected = effectCalls === 0
    checks.newestDecisionUsed = requests.some(request => request.root === 'A' && request.text.includes('NEWEST_VALUE') && request.text.includes('The user changed this work'))
    checks.turnEndNotTaskCompletion = service.get(a)?.status === 'waiting'
    checks.roleRoutes = requests.every(request => request.root === 'foreground' ? request.model === 'chat-script' : request.model === 'work-script')
    checks.workerTranscriptNotInFrontJournal = !store.records().some(row => row.type === 'assistant/message' && row.text.includes('Used NEWEST_VALUE'))
    checks.consumptionReceipts = service.get(a)?.inputs.every(input => input.state === 'consumed') === true
    await until(() => !service.busy())
    phase = 'story-complete'; selected = 'A'; storyWork = () => service.get(a)!
    assert.equal(send({ type: 'work.resume', target: target(a) }).status, 'accepted')
    await until(() => service.get(a)?.delivery?.state === 'consumed' && store.projection().task?.status === 'completed')
    if (failure) throw failure
    checks.nativeFileEvidenceCompletesWork = service.get(a)?.status === 'completed' && readFileSync(join(projects.A, 'output.txt'), 'utf8') === 'NEWEST_VALUE\n'
    checks.deliveryBeforeMemoryExtraction = store.records().some(row => row.type === 'assistant/message' && row.text.includes('verified hash'))
    phase = 'story-immediate-question'; await chat('What did you just finish?')
    checks.immediateFollowupUsesCheckpoint = requests.at(-1)?.text.includes('Wrote NEWEST_VALUE to output.txt.') === true
    const receipt = service.get(a)!.delivery!.eventId
    service.stateChanged(); service.stateChanged()
    checks.singleDelivery = store.records().filter(row => row.type === 'inbox/event' && row.id === receipt).length === 1
    const userDecisions = seenFragments(store.records(), true, true).filter(item => item.origin === 'user')
    checks.originalDecisionsNotRecaptured = userDecisions.filter(item => item.text.includes('For task A use NEWEST_VALUE')).length === 1
    checks.handoffsNotNewExperiences = !seenFragments(store.records(), true, true).some(item => item.text.includes('Delivered output.txt') || item.text.includes('Read the current work checkpoint'))
    clock.advanceBy(86_400_000); phase = 'story-next-day'; await chat('What was the completed result yesterday?')
    checks.nextDayUsesSameWorkIdentity = requests.at(-1)?.text.includes(a) === true && requests.at(-1)?.text.includes('Wrote NEWEST_VALUE to output.txt.') === true
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks))
  }
  let stopDeadline = () => {}
  let cleanupFailure: unknown
  try { await Promise.race([steps(), new Promise<never>((_done, reject) => { stopDeadline = systemClock.after(90_000, () => reject(new Error('EXECUTION_GATE_TIMEOUT'))) })]) }
  finally {
    stopDeadline()
    const closing = await Promise.allSettled([service.close(), foreground.close()])
    await host.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close(); controller.dispose()
    for (const result of closing) if (result.status === 'rejected') cleanupFailure = result.reason
  }
  if (cleanupFailure) throw cleanupFailure
}
const requestSummary = () => requests.map(({ model, root, phase }) => ({ model, root, phase }))
run().then(() => { writeFileSync(join(root, 'report.json'), JSON.stringify({ ok: true, phase, checks, requests: requestSummary() }, null, 2)) }, error => {
  writeFileSync(join(root, 'report.json'), JSON.stringify({ ok: false, phase, checks, error: String(error), failure: String(failure), requests: requestSummary() }, null, 2)); process.exitCode = 1
})

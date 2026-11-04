import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createManualClock, systemClock } from '../../src/main/clock'
import { openSessionStore } from '../../src/main/store/session'
import { createScheduler } from '../../src/main/scheduler'
import { createMemoryFacts } from '../../src/main/memory/facts'
import { createMemoryEngine } from '../../src/main/memory/engine'
import { createMemoryService } from '../../src/main/memory/service'
import { createFakeMemoryModel } from '../../src/main/memory/model'
import { projectMemory } from '../../src/main/memory/projection'
import { memoryTools } from '../../src/main/memory/tools'
import { createDshExecution, type DshExecution } from '../../src/main/dsh/execution'
import { createRootHost } from '../../src/main/dsh/root-host'
import { createAppController } from '../../src/main/bridge/controller'
import { createContinuousWork, type ContinuousWorkService, type WorkRuntimeContext } from '../../src/main/work/service'
import { openWorkStore } from '../../src/main/work/store'
import { workTools, workCompletionTools, workContext } from '../../src/main/work/tools'
import { workExperience } from '../../src/main/work/experience'
import { BUILTIN_CARD } from '../../src/main/characters/builtin-persona'
import harnessPolicy from '../../src/main/harness/policy.json'
import type { HarnessTool } from '../../src/main/harness/tools'
import type { AppCommand } from '../../src/shared'
import type { MemoryProposal } from '../../src/main/memory/airi/core'
import type { MemoryHostPort } from '../../src/main/memory/airi/runtime'
import { messageText, workPackage, type ProbeRequest } from './continuity-scripted-model'
import type { StoryQualityIO } from './memory-story-io'

export const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
type WorkPlan = { mode: 'hold' | 'finish' | 'external'; step: number; entered: ReturnType<typeof barrier>; release: ReturnType<typeof barrier>;
  file?: string; content?: string; command?: string; explanation?: string; unresolved?: string[]; risky?: boolean }
const offlineMirror: MemoryHostPort = {
  configure: async () => ({ status: 'error', error: 'Synthetic mirror offline' }), getStatus: async () => ({ status: 'error', error: 'Synthetic mirror offline' }),
  list: async () => { throw new Error('MIRROR_OFFLINE') }, search: async () => { throw new Error('MIRROR_OFFLINE') },
  insert: async () => { throw new Error('MIRROR_OFFLINE') }, update: async () => { throw new Error('MIRROR_OFFLINE') }, remove: async () => { throw new Error('MIRROR_OFFLINE') },
}

/** Same production service composition as work-execution.ts, with controlled setup and independently evaluated answers. */
export async function createStoryHarness(input: { id: string; root: string; repo: string; runtime: string; bridge: string; io: StoryQualityIO; selfTest: boolean; mirrorOffline?: boolean }) {
  const { root, io } = input
  mkdirSync(root, { recursive: true })
  const clock = createManualClock(1_793_635_200_000)
  const store = openSessionStore(root, { userId: 'quality-' + input.id, characterId: 'taozi' }, clock)
  const owner = { userId: store.scope.userId, characterId: store.scope.characterId, dataRootId: root }
  const controller = createAppController(clock, undefined, store), scheduler = createScheduler(clock)
  const projects = { A: join(root, 'project-a'), B: join(root, 'project-b') }
  Object.values(projects).forEach(path => mkdirSync(path, { recursive: true }))
  const plans = new Map<string, WorkPlan>(), questions: unknown[] = [], approvals: string[] = []
  let foreground!: DshExecution, service!: ContinuousWorkService, currentQuery = '', evaluating = false, vectors = false, compacting = false
  let onSettled: (() => void) | undefined
  let host = createRootHost({ dataDir: root })
  const experience = workExperience(store, () => evaluating && !input.selfTest ? 'real' : 'fake')
  const facts = createMemoryFacts({ root: join(root, 'facts'), clock: { ...clock, after: systemClock.after }, store, owner, embedding: () => vectors ? io.embedding : undefined,
    ...(input.mirrorOffline ? { mirror: offlineMirror } : {}), held: () => false, waitForRestore: async () => {}, changed: () => controller.refresh('connection') })
  const model = createFakeMemoryModel().model
  // Source fixture facts are explicitly reviewed; extraction is measured separately in the existing live lifecycle story.
  let extractionCalls = 0
  model.airi = { extract: async () => { extractionCalls++; return [] } }
  const memory = createMemoryService({ clock, store, scheduler, facts,
    repository: { view: () => projectMemory(store.history!()), append: store.append, refresh: () => {}, close: () => {} }, model,
    isBusy: () => foreground?.busy() || service?.busy(), rolled: () => {}, changed: () => controller.refresh('task'), limits: { idleMs: 0 },
    compactRoot: id => foreground.compact(id) })
  scheduler.cancel('memory.maintenance')
  const external = { requests: 0, acknowledged: 0 }
  const externalReceived = barrier()
  // The test server records a real local write, then deliberately withholds its response.
  const externalServer = createServer(req => { void (async () => {
    let bytes = 0; for await (const chunk of req) bytes += chunk.length
    assert.equal(req.method, 'POST'); external.requests++
    writeFileSync(join(root, 'local-external-effect.json'), JSON.stringify({ requests: external.requests, bytes }), { flag: external.requests === 1 ? 'wx' : 'w' })
    externalReceived.resolve()
  })() })
  await new Promise<void>(done => externalServer.listen(0, '127.0.0.1', done))
  const address = externalServer.address(); assert.ok(address && typeof address !== 'string')
  const externalUrl = `http://127.0.0.1:${address.port}/calendar`
  const fixtureTools: HarnessTool[] = [{ templateId: 'fixture.hold', definition: { name: 'story_barrier', description: 'Wait on the isolated fixture tool barrier.',
    parameters: { type: 'object', properties: { workId: { type: 'string' } }, required: ['workId'], additionalProperties: false } }, validate: value => typeof value.workId === 'string',
    run: async (value, context) => {
      const plan = plans.get(String(value.workId)); assert.ok(plan); plan.entered.resolve()
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('FIXTURE_CANCELLED'))
        if (context.signal.aborted) { abort(); return }
        context.signal.addEventListener('abort', abort, { once: true })
        void plan.release.promise.then(() => { context.signal.removeEventListener('abort', abort); resolve() })
      })
      context.signal.throwIfAborted(); return { ok: true, raw: { released: true }, visible: { released: true } }
    } }]
  const changed = () => controller.refresh('task')
  const common = (worker: boolean) => ({ clock, processClock: systemClock, dshRoot: input.runtime, bridge: input.bridge,
    guardedRoots: [join(root, 'facts'), join(root, 'continuous-work'), join(root, 'other-character')], routes: io.routes, source: evaluating && !input.selfTest && !worker ? 'real' as const : 'fake' as const,
    launch: host.launch, persona: () => [harnessPolicy.system, JSON.stringify({ characterCard: { name: BUILTIN_CARD.name, persona: BUILTIN_CARD.persona },
      scope: 'character-configuration-only', authority: 'personality-never-tool-permission' })].join('\n\n'),
    suffix: () => '和用户说话用口语化的中文，像平时聊天一样。做完后用一两句话说清结果。',
    ask: async (_question: string, choices: string[]) => { if (evaluating) return null; approvals.push(choices[0]); return choices[0] },
    question: async (items: unknown) => { questions.push(items); return { status: 'cancelled' } },
    admit: ({ units, bucket }: { units: number; bucket: 'work' | 'autonomous' }) => io.admit(worker, units, bucket) })
  const createService = () => createContinuousWork({ root: join(root, 'continuous-work'), owner, clock, available: () => true, held: () => false, safeText: text => text,
    project: id => { const key = id === 'current' ? 'A' : id; return key === 'A' || key === 'B' ? { id: key, path: projects[key] } : null },
    decision: id => { const row = store.history!().find(row => row.type === 'user/message' && row.id === id); return row?.type === 'user/message' ? { id, text: row.text, atMs: row.atMs } : null },
    observed: experience.observed,
    deliverCheckpoint: (work, checkpoint) => experience.deliver(work, checkpoint, (text, eventId) => foreground.postEvent('work', text, eventId)),
    createRuntime: (context: WorkRuntimeContext) => {
      const path = join(root, 'continuous-work', context.work.identity.workId, String(context.work.identity.generation)); mkdirSync(path, { recursive: true })
      const privateStore = openWorkStore(path, owner, clock, context.work.runStartedAt, store)
      const execution = createDshExecution({ ...common(true), store: privateStore, dataDir: path, project: () => context.work.projectPath,
        tools: () => [...fixtureTools, ...workCompletionTools(service, context.work.identity)], rootPolicy: { role: 'worker', work: context.work.identity },
        consumed: context.consumed, evidence: context.evidence, successfulInputs: context.successfulInputs, changed,
        settled: () => { const row = privateStore.records().findLast(row => row.type === 'turn/end'); context.settled(row?.type === 'turn/end' && row.reason === 'error') } })
      return { ...execution, close: async () => { await execution.close(); privateStore.close() } }
    }, changed })
  const createForeground = () => createDshExecution({ ...common(false), store, dataDir: root, project: () => projects.A,
    rootPolicy: { role: 'foreground', work: null }, tools: () => [...memoryTools(memory), ...workTools(service)],
    consumed: id => { experience.consumed(id); service.consumedDelivery(id) },
    reference: async ({ requestId, firstOfSession }) => ({ ...await memory.reference(currentQuery, requestId, firstOfSession), ...workContext(service) }),
    referencesPrepared: (id, reference) => memory.disclose(id, reference), started: ({ requestId, turnId }) => memory.bind(requestId, turnId),
    changed: reason => controller.refresh(reason), settled: () => { onSettled?.(); onSettled = undefined } })
  service = createService(); foreground = createForeground()
  controller.attachMemory(memory); controller.attachContinuousWork(service); controller.attachExecution(foreground, true)
  const dispatch = (body: Record<string, unknown>) => controller.dispatch({ protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: randomUUID(), ...body } as AppCommand)
  const until = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    let stop = () => {}; const cancel = systemClock.after(120_000, () => { stop(); reject(new Error('STORY_BOUNDARY_TIMEOUT')) })
    const check = () => { if (predicate()) { stop(); cancel(); resolve() } }
    stop = controller.subscribe(check); check()
  })
  const chat = async (text: string) => {
    await until(() => !foreground.busy())
    currentQuery = text
    let cancel = () => {}
    const done = new Promise<void>((resolve, reject) => { cancel = systemClock.after(600_000, () => reject(new Error('STORY_TURN_TIMEOUT'))); onSettled = resolve })
    try { assert.equal(dispatch({ type: 'message.send', text }).status, 'accepted'); await foreground.prepared(); await done
      assert.ok(!io.state().halted, 'STORY_IO_FAILED'); assert.equal(store.projection().task?.status, 'completed', 'STORY_TURN_FAILED') }
    finally { cancel() }
    const row = store.records().findLast(row => row.type === 'user/message'); assert.ok(row?.type === 'user/message'); return row
  }
  const source = () => { const row = store.records().findLast(row => row.type === 'user/message'); assert.ok(row?.type === 'user/message'); return row }
  const remember = async (content: string, proposal: Partial<MemoryProposal> = {}) => {
    const row = source(), operationId = randomUUID()
    const value = proposal.kind === 'forget' ? { kind: 'forget', targetId: proposal.targetId, expectedRevision: proposal.expectedRevision }
      : { kind: 'remember', content, title: '', summary: '', ...proposal }
    // Match memoryTools' authored-user identity; a bare UUID is not a successful-input source ID.
    const operation = await facts.propose('fixture-review:' + row.id, `event:${row.id}`, operationId, value as MemoryProposal, new AbortController().signal)
    assert.equal((await facts.review(operationId, true)).status, 'applied')
    assert.equal(facts.experiencePolicy().legacyCutoff, 0, 'FIXTURE_SOURCE_NOT_LINKED')
    return operation.fragmentId
  }
  const target = (id: string) => { const work = service.get(id)!; return { identity: work.identity, expectedRevision: work.revision } }
  const start = (project: 'A' | 'B', options: Partial<WorkPlan> = {}) => {
    const row = source(); const result = service.dispatch({ type: 'work.create', projectId: project, objective: row.text, acceptance: [], decisionIds: [row.id] }, randomUUID())
    assert.ok(!result.error && result.work); const id = result.work.identity.workId
    plans.set(id, { mode: 'hold', step: 0, entered: barrier(), release: barrier(), ...options }); return id
  }
  const supplement = (id: string) => { const row = source(); assert.ok(!service.dispatch({ type: 'work.supplement', target: target(id), text: row.text, decisionId: row.id }, randomUUID()).error) }
  const script = (body: ProbeRequest) => {
    if (compacting && body.model !== 'quality-worker-script') return { text: '已压缩早先对话。最新审核事实以当前记忆引用为准，旧值不覆盖新决定。' }
    const pack = workPackage(body)
    if (body.model !== 'quality-worker-script' || !pack) return { text: '已收到。' }
    const plan = plans.get(pack.identity.workId); assert.ok(plan, 'WORK_PLAN_MISSING')
    const call = (name: string, args: unknown) => { const tool = body.tools?.find(tool => tool.function.name === name || tool.function.name === 'lca_' + name); assert.ok(tool, 'WORK_TOOL_MISSING'); return { tool: tool.function.name, args } }
    if (plan.mode === 'hold') return call('story_barrier', { workId: pack.identity.workId })
    if (plan.mode === 'external') {
      assert.equal(external.requests, 0, 'EXTERNAL_REPEAT_PREVENTED')
      const disposable = join(service.get(pack.identity.workId)!.projectPath, 'risk-disposable.txt')
      assert.equal(realpathSync(disposable), disposable); assert.ok(lstatSync(disposable).isFile() && !lstatSync(disposable).isSymbolicLink())
      // A verified, explicitly created single fixture file; -Recurse exercises the existing approval classifier in S20.
      return call('pwsh', { description: 'Issue one isolated local calendar request', command: `Remove-Item -LiteralPath '${disposable.replaceAll("'", "''")}'${plan.risky ? ' -Recurse' : ''}; Invoke-WebRequest -Method Post -Uri '${externalUrl}' -Body 'calendar-fixture'`, timeout: 180000 })
    }
    if (messageText(body.messages.findLast(message => message.role === 'tool')?.content).includes('trusted this project')) plan.step--
    const steps = ['write', ...(plan.command ? ['command'] : []), 'inspect', 'finish', 'end']
    const step = steps[Math.max(0, plan.step++)]
    if (step === 'write') return call('write', { file_path: plan.file!, content: plan.content! })
    if (step === 'command') return call('pwsh', { description: 'Run the isolated fixture check', command: plan.command, timeout: 120000 })
    if (step === 'inspect') return call('inspect_current_work', {})
    if (step === 'finish') {
      const work = service.get(pack.identity.workId)!, proofs = work.evidence?.filter(item => item.status === 'passed' && item.identity.objectiveRevision === work.identity.objectiveRevision) ?? []
      assert.ok(proofs.some(item => item.kind === 'artifact'))
      if (plan.command) assert.ok(proofs.some(item => item.kind === 'command' && item.exitCode === 0), 'REAL_COMMAND_EVIDENCE_MISSING')
      return call('finish_work', { expectedObjectiveRevision: work.identity.objectiveRevision, evidenceIds: proofs.map(item => item.id),
        outcome: plan.unresolved?.length ? 'partial' : 'completed', explanation: plan.explanation ?? '本地文件已生成。', unresolved: plan.unresolved ?? [], nextStep: null })
    }
    return { text: '工作检查点已提交。' }
  }
  io.activate(input.id, script)
  await memory.initialize(); assert.equal(facts.status().state, 'ready')
  if (input.mirrorOffline) await facts.runtime.configureRemoteHost('')
  return { clock, store, facts, memory, projects, plans, chat, remember, source, start, supplement, until, approvals, questions, external, externalReceived,
    work: (id: string) => service.get(id)!, works: () => service.view(), extractionCalls: () => extractionCalls,
    async stop(id: string) { assert.ok(!service.dispatch({ type: 'work.stop', target: target(id) }, randomUUID()).error); await until(() => service.get(id)?.status === 'stopped') },
    async finish(id: string, options: Partial<WorkPlan>) { const plan = plans.get(id)!; Object.assign(plan, options, { mode: 'finish', step: 0 }); plan.release.resolve(); await until(() => !!service.get(id)?.delivery); await until(() => !foreground.busy()) },
    async roll(days: number) { const before = store.scope.sessionId; clock.advanceBy(days * 86_400_000); await memory.maintenance();
      assert.notEqual(store.scope.sessionId, before, 'DAY_DID_NOT_ROLL'); return before },
    async compact() { compacting = true; try { assert.equal(dispatch({ type: 'context.compact' }).status, 'accepted'); await memory.idle(); assert.equal(memory.view().compaction?.outcome, 'compacted') } finally { compacting = false } },
    async restartServices() {
      await service.close(); await foreground.close(); await host.close()
      host = createRootHost({ dataDir: root }); service = createService(); foreground = createForeground()
      controller.attachContinuousWork(service); controller.attachExecution(foreground, true)
    },
    async seedOtherCharacter() {
      const other = { ...owner, characterId: 'another-character' }, scope = { userId: other.userId, characterId: other.characterId }
      const engine = createMemoryEngine({ root: join(root, 'other-character'), owner: other, clock, embedding: () => undefined,
        held: () => false, waitForRestore: async () => {}, journal: () => {} })
      try {
        const operationId = randomUUID()
        await engine.runtime.proposeOperation({ scope, sessionId: 'other-character-day', turnId: operationId,
          sourceContext: { sessionId: 'other-character-day', messageId: operationId, neighbors: [] }, isCurrent: () => true }, operationId,
        { kind: 'remember', content: '考试日期是 11 月 19 日。', title: '', summary: '' })
        assert.equal((await engine.runtime.confirmOperation(scope, operationId, true)).status, 'applied')
        assert.equal((await engine.runtime.list()).length, 1)
      } finally { await engine.dispose() }
    },
    async answer(question: string, useVectors = true) {
      await until(() => !foreground.busy()); await foreground.close()
      evaluating = true; vectors = useVectors; io.evaluate()
      if (vectors) { await facts.runtime.refreshEmbedding(); await facts.runtime.idle(); assert.equal(facts.runtime.embeddingMigration.value.state, 'complete') }
      foreground = createForeground(); controller.attachExecution(foreground, true)
      const before = store.history!().length; await chat(question)
      const rows = store.history!().slice(before), answers = rows.filter(row => row.type === 'assistant/message')
      const answer = answers.map(row => row.type === 'assistant/message' ? row.text : '').join('\n')
      assert.ok(answer.trim(), 'NO_FINAL_ANSWER')
      return { answer, questions: structuredClone(questions), toolEvents: rows.filter(row => row.type === 'work/activity'),
        references: io.state().references.filter(row => row.story === input.id), facts: facts.factViews(), engine: facts.status(), works: service.view(),
        checkpoints: workContext(service), extractionCalls, approvals: [...approvals], external: { ...external }, sessionId: store.scope.sessionId }
    },
    fileProof(project: 'A' | 'B', file: string) { const path = join(projects[project], file); assert.ok(existsSync(path)); const bytes = readFileSync(path); return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length } },
    async close() { await service.close(); await foreground.close(); await host.close(); await memory.close(); scheduler.dispose(); controller.dispose(); store.close(); externalServer.closeAllConnections(); await new Promise<void>(done => externalServer.close(() => done())) },
  }
}
export type StoryHarness = Awaited<ReturnType<typeof createStoryHarness>>

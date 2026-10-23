// lca-bridge: lets the LCA main process drive DSH agents over the Node IPC channel it opened.
// It contributes her persona per agent, exposes LCA's own tools, forwards session activity for the
// book UI, and sends every approval to LCA. Out-of-tree plugin: DSH imports resolve through the
// profile runtime, so it shares the installation's single Cordis instance.
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DELEGATION, HANDOFF_FEEDBACK, TRUST_FEEDBACK, createLineage, gatedWhileDegraded, handoffOf, isRisky, parseRoutes, sameModel, sandboxDenied, sourceOf, subjectOf } from './policy.js'
import { createFamilySafety } from './family.js'

export const name = 'lca-bridge'
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'systemPrompt', 'tools', 'approval', 'llm', 'sessionProjections']

const CLIP = 4000
const SOURCES = new Set(['mail', 'document', 'web', 'mcp', 'plugin', 'member'])

export function apply(ctx) {
  if (typeof process.send !== 'function') throw new Error('lca-bridge needs the IPC channel of its LCA parent')
  const send = (message) => { if (process.connected) process.send(message) }
  const lcaSources = new Map() // LCA tool name -> the third-party source its results carry (mail, documents, plugins)
  const live = new Map() // root session id -> { handle, cwd }
  const bindings = new Map() // root id -> main-issued project and runtime binding
  const registered = new Set()
  const canonical = (path) => {
    let value = resolve(path)
    try { value = realpathSync.native(value) } catch { /* an unavailable project is rejected by main */ }
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
  const calls = new Map()
  const asked = new Map() // callId -> { kind, command } for approvals this plugin asked for
  const subjects = new Map() // callId -> short subject for an approval card (approval requests carry no arguments)
  const questions = new Map() // id -> { done, fail } for her questions waiting on your answer in the book
  const askCalls = new Map() // root session id -> callId of her ask_user_question in flight (the question request carries none)
  const turns = new Map() // root session id -> current DSH turn number
  // A turn LCA opened for an event (pomodoro, mail, her life) is short: capped at EVENT_STEPS unless you join in.
  const EVENT_STEPS = 6
  const eventStarts = new Map() // root session id -> event turns DSH has yet to begin
  const eventTurns = new Map() // root session id -> DSH turn number opened by an event
  // LCA's resource ledger: every step of her family asks LCA first. A turn LCA opened for an event is admitted
  // against the autonomous allowance; your own turns are recorded there but never refused. The estimate is the
  // previous step's usage (input + output + a tenth of cache reads), or 16k before any usage is known.
  const admissions = new Map() // id -> settle(boolean)
  const lastUnits = new Map() // root session id -> units of its latest step
  const unitsOf = (usage) => Math.max(1, Math.round(Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0) + Number(usage?.cacheReadTokens ?? 0) / 10))
  const admit = (root, role, origin) => new Promise((settle) => {
    const id = randomUUID(); admissions.set(id, settle)
    send({ t: 'admit', id, sessionId: root, origin, role, bucket: eventTurns.has(root) && eventTurns.get(root) === turns.get(root) ? 'autonomous' : 'work', units: lastUnits.get(root) ?? 16_000 })
  })
  // LCA's private data (journals, connection settings) and the DSH home are never her working material.
  const guarded = (process.env.LCA_GUARDED_ROOTS ?? '').split(';').filter(Boolean).map((root) => resolve(root).toLowerCase())
  const lineage = createLineage((id) => bindings.has(id))
  const originOf = (agent, visiting = new Set()) => {
    const sid = lineage.sid(agent)
    if (!sid || visiting.has(sid)) return null
    visiting.add(sid)
    const parentSessionId = agent.session.header?.parentSession == null ? null : String(agent.session.header.parentSession)
    if (parentSessionId && !bindings.has(sid)) {
      const parent = ctx.agents.get(parentSessionId)
      if (parent) originOf(parent, visiting)
    }
    const rootSessionId = lineage.rootOf(agent), binding = bindings.get(rootSessionId)
    if (!binding || typeof agent.session.header?.cwd !== 'string' || canonical(agent.session.header.cwd) !== canonical(binding.cwd)) return null
    const origin = { ...binding, cwd: canonical(agent.session.header.cwd), rootSessionId, sessionId: sid, parentSessionId: sid === rootSessionId ? null : parentSessionId }
    if (!registered.has(sid)) { registered.add(sid); send({ t: 'member', origin }) }
    return origin
  }
  const safety = createFamilySafety(ctx, { originOf, send, sourceOf: (name) => sourceOf(name) ?? (lcaSources.has(name) ? lcaSources.get(name) : DELEGATION.has(name) || name === 'list_agents' || name.startsWith('team_task_') ? 'member' : name.startsWith('lca_') ? 'plugin' : null) })
  const callKey = (agent, callId) => `${lineage.sid(agent)}:${String(callId)}`
  // Chat and work models; a thinking level the model does not offer is dropped (DSH would refuse the request).
  const routes = parseRoutes(process.env.LCA_DSH_ROUTES)
  const levels = new Map() // `${provider}/${model}` -> Promise<string[] | null>
  const levelsOf = (route) => {
    const key = `${route.provider}/${route.model}`
    if (!levels.has(key)) levels.set(key, ctx.llm.resolveModelInfo(route.provider, route.model).then((info) => info.reasoning?.efforts.map((effort) => String(effort.id)) ?? null, () => null))
    return levels.get(key)
  }
  const usable = async (route) => {
    const offered = route.effort ? await levelsOf(route) : null
    return { provider: route.provider, model: route.model, ...(route.effort && offered?.includes(route.effort) ? { effort: route.effort } : {}) }
  }
  // Checked once before sessions open (and after each level change), so a switch is synchronous: DSH
  // reads the selection when it assembles the next step, right after the tool call that switched it.
  let picked = null
  const pick = async () => { if (routes) picked = { chat: await usable(routes.chat), work: await usable(routes.work) } }
  const selectionOf = (route) => ({ provider: route.provider, model: route.model, ...(route.effort ? { reasoningEffort: ReasoningEffortId(route.effort) } : {}) })
  const models = new Map() // root session id -> { selection, role: 'chat' | 'work' }
  const choose = (sessionId, role) => {
    const entry = models.get(sessionId)
    if (!entry || !picked) return
    entry.role = role
    entry.selection.current = selectionOf(picked[role])
  }
  let persona = ''
  let suffix = ''
  let toolDisposers = []

  const isRoot = (agent) => live.has(lineage.sid(agent))
  const texts = (blocks) => (blocks ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
  const clip = (value) => (value.length > CLIP ? value.slice(0, CLIP) + '…' : value)
  const plain = (value) => JSON.parse(JSON.stringify(value ?? null))

  const registerLcaTools = (tools) => {
    for (const dispose of toolDisposers) dispose()
    lcaSources.clear()
    for (const tool of tools) lcaSources.set(tool.name, SOURCES.has(tool.source) ? tool.source : null)
    toolDisposers = tools.map((tool) => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      execute: (args, exec) => new Promise((done, fail) => {
        const origin = originOf(exec.agent)
        if (!origin) { fail(new Error('DSH_ORIGIN_UNAVAILABLE')); return }
        const id = randomUUID()
        const root = lineage.rootOf(exec.agent)
        const callId = String(exec.callId)
        calls.set(id, { done: (value, source) => { try { if (SOURCES.has(source)) safety.recordSource(exec, source); done(value) } catch { fail(new Error('LCA_SOURCE_RECORD_FAILED')) } }, fail })
        exec.signal?.addEventListener('abort', () => { if (calls.delete(id)) fail(new Error('cancelled')) }, { once: true })
        send({ t: 'lca-call', id, sessionId: root ?? lineage.sid(exec.agent), origin, callId, name: tool.name, args: plain(args) })
      }),
    }))
  }

  // Only LCA decides trust, and only for a project the user granted in the book.
  const presetOf = (session) => ctx.get('permissionPresets')?.current(session) ?? null

  const open = async ({ sessionId, cwd, trusted, binding, resume }) => {
    if (binding?.protocolVersion !== 2 || !['runtimeId', 'projectId', 'cwd'].every((key) => typeof binding[key] === 'string' && binding[key]) || canonical(binding.cwd) !== canonical(cwd)) throw new Error('DSH_BINDING_REQUIRED')
    await ctx.get('loader')?.await()
    if (routes && !picked) await pick()
    const chat = picked ? selectionOf(picked.chat) : ctx.agentDefaultModel.currentSelection()
    const selection = { current: chat, assembled: undefined }
    const id = brandString(sessionId ?? `session-${randomUUID()}`)
    bindings.set(String(id), { protocolVersion: 2, runtimeId: binding.runtimeId, projectId: binding.projectId, cwd: canonical(binding.cwd) })
    safety.bind(String(id), trusted)
    const setup = (agentCtx) => {
      installModelSelection(agentCtx, selection)
      if (persona) agentCtx.systemPrompt.section({ name: 'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: persona, interpolate: false })
      if (suffix) agentCtx.systemPrompt.section({ name: 'deployment:persona-suffix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: suffix, interpolate: false })
    }
    const agentOptions = { provider: chat.provider, model: chat.model }
    const handle = sessionId && resume !== false && ctx.get('sessionQuery')
      ? await ctx.agents.resume({ resumeSessionId: id, agentOptions, setup }).catch(() => ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions, setup }))
      : await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions, setup })
    live.set(String(id), { handle, cwd })
    if (!originOf(handle.agent)) { live.delete(String(id)); bindings.delete(String(id)); await handle.dispose(); throw new Error('DSH_PROJECT_MISMATCH') }
    models.set(String(id), { selection, role: 'chat' })
    safety.ensure(handle.agent)
    return { sessionId: String(id), cwd, provider: chat.provider, model: chat.model, preset: presetOf(handle.agent.session) }
  }

  const agentOf = (sessionId) => {
    const entry = live.get(sessionId)
    if (!entry) throw new Error(`lca-bridge: no live session ${sessionId}`)
    return entry.handle.agent
  }

  // Graceful DSH disposal, then drop the IPC channel: an open channel keeps the process alive.
  let closing
  const shutdown = () => closing ??= (async () => {
    for (const [, entry] of live) await entry.handle.dispose().catch(() => {})
    live.clear()
    ctx.get('appExit')?.(0)
    if (process.connected) process.disconnect()
  })()

  // Policy layer for her whole family of agents: refuse LCA's private roots, ask before risky
  // commands, and while third-party content is in context ask before every write, command or fetch.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const root = lineage.rootOf(exec.agent)
    if (!root || !originOf(exec.agent)) return { kind: 'deny', reason: 'LCA cannot verify this agent and project. Ask the user to start a new task.' }
    if (!safety.beforeTool(exec)) return { kind: 'deny', reason: 'This member activation is no longer authorized.' }
    // Runtime-wide plugin changes could remove this policy itself. Extension writes use LCA's main-owned adapter.
    if (String(exec.name) === 'plugin_manager' && !['list', 'inspect'].includes(exec.arguments?.action)) return { kind: 'deny', reason: 'Manage extensions through LCA settings.' }
    if (String(exec.name) === 'ask_user_question' && isRoot(exec.agent)) askCalls.set(root, String(exec.callId))
    const args = JSON.stringify(exec.arguments ?? {}).toLowerCase().replaceAll('\\\\', '\\')
    if (guarded.some((path) => args.includes(path) || args.includes(path.replaceAll('\\', '/')))) return { kind: 'deny', reason: 'This path is LCA private data; she does not work on it.' }
    const model = models.get(root)
    const handoff = picked && model?.role === 'chat' && isRoot(exec.agent) && !sameModel(picked.chat, picked.work) ? handoffOf(String(exec.name)) : null
    if (handoff) {
      choose(root, 'work')
      send({ t: 'model', sessionId: root, role: 'work' })
      if (handoff === 'redo') { send({ t: 'handoff', sessionId: root, callId: String(exec.callId) }); return { kind: 'deny', reason: HANDOFF_FEEDBACK } }
    }
    const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
    if (subjects.size > 512) subjects.clear()
    subjects.set(callKey(exec.agent, exec.callId), subjectOf(exec.arguments))
    if (isRisky(command)) {
      asked.set(callKey(exec.agent, exec.callId), { kind: 'risky', command })
      return { kind: 'ask', reason: `Risky command: ${command.slice(0, 200)}` }
    }
    if (safety.sources(exec.agent).length && gatedWhileDegraded(String(exec.name))) {
      asked.set(callKey(exec.agent, exec.callId), { kind: 'degraded', command: command || null })
      return { kind: 'ask', reason: 'Third-party content is in this turn; the user approves each write, command and fetch.' }
    }
    return next()
  }, { prepend: true })

  // The first time the OS sandbox cannot run a command in her project, ask the user about trusting
  // the project instead of letting her read the raw ACL error and set out to repair permissions.
  // Main serializes project decisions; a "not now" holds until revocation or runtime restart.
  const declined = new Set()
  const askTrust = async (root, exec, subject) => {
    const outcome = await safety.request(exec.agent, { toolName: String(exec.name), callId: String(exec.callId), reason: null, kind: 'trust', command: null, subject, degraded: null }, exec.signal)
    if (outcome === 'allowed-once') { safety.setTrust(root, true); send({ t: 'trusted', sessionId: root, preset: presetOf(exec.agent.session) }); return 'trusted' }
    if (outcome !== 'cancelled') declined.add(root)
    return 'declined'
  }
  const block = (text) => ({ kind: 'block', feedback: [{ type: 'text', text }] })

  // ACL feedback uses the executing member's sources, never only the lead's state.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const root = lineage.rootOf(exec.agent)
    if (root) {
      const subject = subjects.get(callKey(exec.agent, exec.callId)) ?? null
      subjects.delete(callKey(exec.agent, exec.callId))
      if (sandboxDenied(result)) {
        if (safety.sources(exec.agent).length) return block(TRUST_FEEDBACK.degraded)
        if (declined.has(root)) return block(TRUST_FEEDBACK.declined)
        if (presetOf(exec.agent.session) === 'lca-trusted') return block(TRUST_FEEDBACK.declined)
        return block(TRUST_FEEDBACK[await askTrust(root, exec, subject)])
      }
    }
    return next()
  })

  // Source retirement is installed by family.js around this admission hook.
  ctx.on('agent/pre-step', async (payload, next) => {
    const family = lineage.rootOf(payload.agent)
    const origin = originOf(payload.agent)
    if (!family || !origin) return { kind: 'reject' }
    if (family && !payload.signal?.aborted) {
      const role = isRoot(payload.agent) ? models.get(family)?.role ?? 'chat' : 'work'
      if (!(await admit(family, role, origin))) return { kind: 'reject' }
    }
    const root = lineage.sid(payload.agent)
    if (live.has(root) && eventTurns.get(root) === payload.turn && payload.step > EVENT_STEPS) {
      eventTurns.delete(root)
      queueMicrotask(() => payload.agent.cancel({ kind: 'user' }))
    }
    return next()
  })

  ctx.on('approval/request', async (request) => {
    const root = lineage.rootOf(request.agent)
    if (!root || !originOf(request.agent)) return 'rejected'
    const callId = request.callId ? String(request.callId) : null
    const key = callKey(request.agent, callId)
    const ask = asked.get(key) ?? null, subject = subjects.get(key) ?? null
    asked.delete(key)
    return safety.request(request.agent, { toolName: request.toolName, callId, reason: request.reason ?? null, kind: ask?.kind ?? 'escalation', command: ask?.command ?? null,
      subject, degraded: safety.sources(request.agent) }, request.signal)
  })

  // Her questions to you (DSH ask_user_question) are answered in the book, which may hold them while you focus. A
  // subagent's never reach you: DSH refuses them before this point. Declining answers every question as skipped.
  ctx.on('user-questions/request', async (request, next) => {
    const root = lineage.rootOf(request.agent)
    if (!root || !isRoot(request.agent)) return next()
    const id = randomUUID()
    const callId = askCalls.get(root) ?? null; askCalls.delete(root)
    send({ t: 'question', id, sessionId: root, origin: originOf(request.agent), callId, questions: plain(request.questions) })
    return await new Promise((done, fail) => {
      questions.set(id, { done, fail })
      request.signal?.addEventListener('abort', () => { if (questions.delete(id)) { send({ t: 'question-cancel', id }); fail(new Error('the question was withdrawn before the user answered')) } }, { once: true })
    })
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!isRoot(agent) || frame.type !== 'chunk') return
    if (frame.chunk.type === 'text-delta' && frame.chunk.text) send({ t: 'delta', sessionId: lineage.sid(agent), text: frame.chunk.text })
  })

  ctx.on('agent/error', ({ agent, error }) => {
    if (isRoot(agent)) send({ t: 'agent-error', sessionId: lineage.sid(agent), message: error instanceof Error ? error.message : String(error) })
  })

  ctx.on('session/event', (session, event) => {
    const entry = [...live].find(([, value]) => value.handle.agent.session === session)
    if (!entry) return
    const sessionId = entry[0]
    const data = event.data
    // Surface replacements (compaction, pruning, retirement) rewrite history; they are not new activity.
    if (event.surfaceOp?.op === 'replace') return
    switch (event.type) {
      // Every turn starts on the chat model; she reaches the work model by starting to work.
      case 'turn/start': {
        turns.set(sessionId, data.turn); choose(sessionId, 'chat')
        const queued = eventStarts.get(sessionId) ?? 0
        if (queued > 0) { eventStarts.set(sessionId, queued - 1); eventTurns.set(sessionId, data.turn) } else eventTurns.delete(sessionId)
        send({ t: 'turn-start', sessionId, turn: data.turn, preset: presetOf(session), sourcePolicy: 2 })
        // An original you asked to see rides in this turn's opening message: the turn is degraded, and the next one retires it.
        break
      }
      case 'user/message': {
        send({ t: 'user-message', sessionId, kind: data.source?.kind ?? null, chars: texts(data.content).length }); break
      }
      case 'turn/end': send({ t: 'turn-end', sessionId, turn: data.turn, reason: plain(data.reason) }); break
      case 'assistant/message': {
        const toolCalls = (data.message.content ?? []).filter((block) => block.type === 'tool-call').map((block) => ({ id: String(block.id), name: block.name }))
        if (data.usage) lastUnits.set(sessionId, unitsOf(data.usage))
        send({ t: 'message', sessionId, turn: data.turn, step: data.step, text: texts(data.message.content), toolCalls, usage: plain(data.usage) })
        break
      }
      case 'tool/call': send({ t: 'tool-call', sessionId, callId: String(data.callId), name: data.name, args: clip(data.arguments) }); break
      case 'tool/result': {
        send({ t: 'tool-result', sessionId, callId: String(data.message.toolCallId), isError: !!data.message.isError })
        break
      }
      case 'system/message': send({ t: 'system', sessionId, chars: texts(data.content ?? data.message?.content).length }); break
      // DSH asks the model again after a transient failure (a cut stream, a busy server): that attempt's text is gone.
      case 'llm/retry-started': send({ t: 'retry', sessionId, turn: data.turn, step: data.step, retry: data.retry }); break
      default: break
    }
  })

  const onMessage = async (message) => {
    try {
      switch (message?.t) {
        case 'init':
          persona = message.persona ?? ''
          suffix = message.suffix ?? ''
          registerLcaTools(message.tools ?? [])
          send({ t: 'init-ok', tools: ctx.tools.schemas?.().map((tool) => tool.name) ?? null })
          break
        case 'tools': registerLcaTools(message.tools ?? []); break
        case 'open':
          // Her card and your profile as they are now: onboarding names them after DSH has started.
          if (typeof message.persona === 'string') persona = message.persona
          if (typeof message.suffix === 'string') suffix = message.suffix
          send({ t: 'session', ref: message.ref, ...(await open(message)) }); break
        case 'send': {
          const agent = agentOf(message.sessionId)
          // LCA's memory references (earlier days, recalled memories) ride in their own block before your words.
          // Some protocols join a message's text blocks into one string: a blank line keeps the reference apart from your words.
          const reference = typeof message.reference === 'string' && message.reference ? [{ type: 'text', text: message.reference + '\n\n' }] : []
          // A third-party original rides in this message (you asked to see it): the turn it opens is degraded.
          const degrade = Array.isArray(message.degrade) ? message.degrade.filter((source) => SOURCES.has(source)) : []
          const event = message.origin === 'event'
          const authorizationId = safety.begin(agent, message.mode === 'followup')
          const input = createUserMessage({ content: [...reference, { type: 'text', text: message.text }], source: { kind: event ? 'lca-event' : 'user', lcaProvenance: { authorizationId, sources: degrade }, ...(reference.length ? { lcaReferences: true } : {}) } })
          if (event && message.mode === 'followup') eventStarts.set(message.sessionId, (eventStarts.get(message.sessionId) ?? 0) + 1)
          // You joined in: the turn is yours, no event cap.
          if (!event) eventTurns.delete(message.sessionId)
          if (message.mode === 'steer') agent.steer(input); else if (message.mode === 'inject') agent.inject(input); else agent.followup(input)
          break
        }
        case 'cancel': safety.cancel(message.sessionId); break
        case 'trust': { safety.setTrust(message.sessionId, true); send({ t: 'trusted', sessionId: message.sessionId, preset: presetOf(agentOf(message.sessionId).session) }); break }
        case 'untrust': { safety.setTrust(message.sessionId, false); declined.delete(message.sessionId); send({ t: 'trusted', sessionId: message.sessionId, preset: presetOf(agentOf(message.sessionId).session) }); break }
        case 'question-answer': {
          const entry = questions.get(message.id)
          if (!entry) break
          questions.delete(message.id)
          if (Array.isArray(message.answers)) entry.done({ answers: message.answers }); else entry.fail(new Error(String(message.error ?? 'the user did not answer')))
          break
        }
        case 'approval-answer': safety.answer(message.id, message.outcome); break
        case 'admit-answer': { const settle = admissions.get(message.id); if (settle) { admissions.delete(message.id); settle(message.ok !== false) } break }
        case 'lca-result': {
          const call = calls.get(message.id)
          if (!call) break
          calls.delete(message.id)
          if (message.ok) call.done(message.value ?? null, message.source ?? null); else call.fail(new Error(message.error ?? 'LCA tool failed'))
          break
        }
        // The thinking levels each role's model offers, for the book's settings; null when DSH cannot tell.
        case 'describe': send({ t: 'described', ref: message.ref, chat: routes ? await levelsOf(routes.chat) : null, work: routes ? await levelsOf(routes.work) : null }); break
        // A new thinking level from the settings: the next step of every session uses it.
        case 'efforts': {
          if (!routes) break
          for (const role of ['chat', 'work']) {
            const effort = message.efforts?.[role]
            routes[role] = { provider: routes[role].provider, model: routes[role].model, ...(typeof effort === 'string' ? { effort } : {}) }
          }
          await pick()
          for (const [sessionId, entry] of models) choose(sessionId, entry.role)
          break
        }
        case 'shutdown': await shutdown(); break
        default: send({ t: 'error', ref: message?.ref, message: `unknown command ${String(message?.t)}` })
      }
    } catch (error) {
      send({ t: 'error', ref: message?.ref, message: error instanceof Error ? error.message : String(error) })
    }
  }
  process.on('message', onMessage)
  process.once('disconnect', () => { void shutdown() })
  ctx.effect(() => () => { process.off('message', onMessage); for (const dispose of toolDisposers) dispose() })
  send({ t: 'hello', pid: process.pid })
}

// lca-bridge: lets the LCA main process drive DSH agents over the Node IPC channel it opened.
// It contributes her persona per agent, exposes LCA's own tools, forwards session activity for the
// book UI, and sends every approval to LCA. Out-of-tree plugin: DSH imports resolve through the
// profile runtime, so it shares the installation's single Cordis instance.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DELEGATION, TRUST_FEEDBACK, createDegradation, createLineage, gatedWhileDegraded, isRisky, retireResults, sandboxDenied, sourceOf, subjectOf } from './policy.js'

export const name = 'lca-bridge'
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'systemPrompt', 'tools', 'approval']

const CLIP = 4000
const SOURCES = new Set(['mail', 'document', 'web', 'mcp', 'plugin'])

export function apply(ctx) {
  if (typeof process.send !== 'function') throw new Error('lca-bridge needs the IPC channel of its LCA parent')
  const send = (message) => { if (process.connected) process.send(message) }
  const live = new Map() // root session id -> { handle, cwd }
  const approvals = new Map()
  const calls = new Map()
  const asked = new Map() // callId -> { kind, command } for approvals this plugin asked for
  const subjects = new Map() // callId -> short subject for an approval card (approval requests carry no arguments)
  const tainted = new Set() // root-level callIds whose results carry third-party content
  const turns = new Map() // root session id -> current DSH turn number
  // LCA's private data (journals, connection settings) and the DSH home are never her working material.
  const guarded = (process.env.LCA_GUARDED_ROOTS ?? '').split(';').filter(Boolean).map((root) => resolve(root).toLowerCase())
  const lineage = createLineage((id) => live.has(id))
  const degradation = createDegradation()
  let persona = ''
  let suffix = ''
  let toolDisposers = []

  const isRoot = (agent) => live.has(lineage.sid(agent))
  const texts = (blocks) => (blocks ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
  const clip = (value) => (value.length > CLIP ? value.slice(0, CLIP) + '…' : value)
  const plain = (value) => JSON.parse(JSON.stringify(value ?? null))

  const degrade = (root, source, callId) => {
    if (callId) tainted.add(callId)
    if (degradation.mark(root, source, turns.get(root) ?? null)) send({ t: 'degraded', sessionId: root, sources: degradation.sources(root) })
  }

  const registerLcaTools = (tools) => {
    for (const dispose of toolDisposers) dispose()
    toolDisposers = tools.map((tool) => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      execute: (args, exec) => new Promise((done, fail) => {
        const id = randomUUID()
        const root = lineage.rootOf(exec.agent)
        const callId = String(exec.callId)
        calls.set(id, { done: (value, source) => { if (root && SOURCES.has(source)) degrade(root, source, isRoot(exec.agent) ? callId : null); done(value) }, fail })
        exec.signal?.addEventListener('abort', () => { if (calls.delete(id)) fail(new Error('cancelled')) }, { once: true })
        send({ t: 'lca-call', id, sessionId: root ?? lineage.sid(exec.agent), callId, name: tool.name, args: plain(args) })
      }),
    }))
  }

  // Only LCA decides trust, and only for a project the user granted in the book.
  const presetOf = (session) => ctx.get('permissionPresets')?.current(session) ?? null
  const trust = (session) => {
    const presets = ctx.get('permissionPresets')
    if (!presets) throw new Error('lca-bridge: permission presets unavailable')
    presets.set(session, 'lca-trusted')
  }

  const open = async ({ sessionId, cwd, trusted, degraded }) => {
    await ctx.get('loader')?.await()
    const selection = ctx.agentDefaultModel.currentSelection()
    const id = brandString(sessionId ?? `session-${randomUUID()}`)
    const setup = (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      if (persona) agentCtx.systemPrompt.section({ name: 'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: persona, interpolate: false })
      if (suffix) agentCtx.systemPrompt.section({ name: 'deployment:persona-suffix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: suffix, interpolate: false })
    }
    const agentOptions = { provider: selection.provider, model: selection.model }
    const handle = sessionId && ctx.get('sessionQuery')
      ? await ctx.agents.resume({ resumeSessionId: id, agentOptions, setup }).catch(() => ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions, setup }))
      : await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions, setup })
    live.set(String(id), { handle, cwd })
    if (trusted === true) trust(handle.agent.session)
    // Third-party content LCA could not retire before a restart: keep the session degraded.
    if (Array.isArray(degraded)) degradation.restore(String(id), degraded.filter((source) => SOURCES.has(source)))
    return { sessionId: String(id), cwd, provider: selection.provider, model: selection.model, preset: presetOf(handle.agent.session) }
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
    if (!root) return next()
    const args = JSON.stringify(exec.arguments ?? {}).toLowerCase().replaceAll('\\\\', '\\')
    if (guarded.some((path) => args.includes(path) || args.includes(path.replaceAll('\\', '/')))) return { kind: 'deny', reason: 'This path is LCA private data; she does not work on it.' }
    const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
    if (subjects.size > 512) subjects.clear()
    subjects.set(String(exec.callId), subjectOf(exec.arguments))
    if (isRisky(command)) {
      asked.set(String(exec.callId), { kind: 'risky', command })
      return { kind: 'ask', reason: `Risky command: ${command.slice(0, 200)}` }
    }
    if (degradation.active(root) && gatedWhileDegraded(String(exec.name))) {
      asked.set(String(exec.callId), { kind: 'degraded', command: command || null })
      return { kind: 'ask', reason: 'Third-party content is in this turn; the user approves each write, command and fetch.' }
    }
    return next()
  })

  // The first time the OS sandbox cannot run a command in her project, ask the user about trusting
  // the project instead of letting her read the raw ACL error and set out to repair permissions.
  // One question per session at a time; a "not now" holds for the rest of the session.
  const asking = new Map() // root session id -> Promise<'trusted' | 'declined' | 'cancelled'>
  const declined = new Set()
  const askTrust = (root, exec, subject) => {
    const session = live.get(root).handle.agent.session
    const pending = new Promise((settle) => {
      const id = randomUUID()
      approvals.set(id, settle)
      exec.signal?.addEventListener('abort', () => { if (approvals.delete(id)) settle('cancelled') }, { once: true })
      send({ t: 'approval', id, sessionId: root, toolName: String(exec.name), callId: String(exec.callId), reason: null, kind: 'trust', command: null, subject, degraded: null })
    }).then((outcome) => {
      asking.delete(root)
      if (outcome === 'allowed-once') { trust(session); send({ t: 'trusted', sessionId: root, preset: presetOf(session) }); return 'trusted' }
      if (outcome === 'cancelled') return 'cancelled'
      declined.add(root)
      return 'declined'
    })
    asking.set(root, pending)
    return pending
  }
  const block = (text) => ({ kind: 'block', feedback: [{ type: 'text', text }] })

  // Third-party results degrade her root session; root-level ones are captured for retirement.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const root = lineage.rootOf(exec.agent)
    if (root) {
      const subject = subjects.get(String(exec.callId)) ?? null
      subjects.delete(String(exec.callId))
      const name = String(exec.name)
      const source = sourceOf(name)
      const top = isRoot(exec.agent)
      if (source) degrade(root, source, top ? String(exec.callId) : null)
      else if (top && DELEGATION.has(name) && degradation.active(root)) tainted.add(String(exec.callId))
      if (top && sandboxDenied(result) && presetOf(live.get(root).handle.agent.session) !== 'lca-trusted') {
        if (degradation.active(root)) return block(TRUST_FEEDBACK.degraded)
        if (declined.has(root)) return block(TRUST_FEEDBACK.declined)
        const outcome = await (asking.get(root) ?? askTrust(root, exec, subject))
        if (outcome !== 'cancelled') return block(TRUST_FEEDBACK[outcome])
      }
    }
    return next()
  })

  // A later turn first retires the third-party results of earlier turns; the turn is then no longer
  // degraded. If they cannot be retired, the new turn stays degraded too.
  ctx.on('agent/pre-step', async (payload, next) => {
    const root = lineage.sid(payload.agent)
    const due = live.has(root) ? degradation.due(root, payload.turn) : null
    if (due) {
      let retired = false
      if (!due.sticky) {
        try { send({ t: 'retired', sessionId: root, count: retireResults(payload.agent.session, [...due.pending.values()], ctx.get('tokenMeter')) }); retired = true }
        catch (error) { ctx.logger?.warn?.(`lca-bridge: could not retire third-party results: ${error instanceof Error ? error.message : String(error)}`) }
      }
      if (retired) degradation.clear(root)
      else { degradation.carry(root, payload.turn); send({ t: 'degraded', sessionId: root, sources: degradation.sources(root) }) }
    }
    return next()
  })

  ctx.on('approval/request', async (request, next) => {
    const root = lineage.rootOf(request.agent)
    if (!root) return next()
    const id = randomUUID()
    const callId = request.callId ? String(request.callId) : null
    const ask = callId ? asked.get(callId) ?? null : null
    const subject = callId ? subjects.get(callId) ?? null : null
    if (callId) { asked.delete(callId); subjects.delete(callId) }
    send({ t: 'approval', id, sessionId: root, toolName: request.toolName, callId, reason: request.reason ?? null, kind: ask?.kind ?? 'escalation', command: ask?.command ?? null,
      subject, degraded: degradation.active(root) ? degradation.sources(root) : null })
    return await new Promise((settle) => {
      approvals.set(id, settle)
      request.signal?.addEventListener('abort', () => { if (approvals.delete(id)) settle('cancelled') }, { once: true })
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
      case 'turn/start': turns.set(sessionId, data.turn); send({ t: 'turn-start', sessionId, turn: data.turn, preset: presetOf(session) }); break
      case 'user/message': send({ t: 'user-message', sessionId, kind: data.source?.kind ?? null, chars: texts(data.content).length }); break
      case 'turn/end': send({ t: 'turn-end', sessionId, turn: data.turn, reason: plain(data.reason) }); break
      case 'assistant/message': {
        const toolCalls = (data.message.content ?? []).filter((block) => block.type === 'tool-call').map((block) => ({ id: String(block.id), name: block.name }))
        send({ t: 'message', sessionId, turn: data.turn, step: data.step, text: texts(data.message.content), toolCalls, usage: plain(data.usage) })
        break
      }
      case 'tool/call': send({ t: 'tool-call', sessionId, callId: String(data.callId), name: data.name, args: clip(data.arguments) }); break
      case 'tool/result': {
        const callId = String(data.message.toolCallId)
        if (tainted.delete(callId)) degradation.capture(sessionId, event)
        send({ t: 'tool-result', sessionId, callId, isError: !!data.message.isError })
        break
      }
      case 'system/message': send({ t: 'system', sessionId, chars: texts(data.content ?? data.message?.content).length }); break
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
        case 'open': send({ t: 'session', ref: message.ref, ...(await open(message)) }); break
        case 'send': {
          const agent = agentOf(message.sessionId)
          const input = createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'user' } })
          if (message.mode === 'steer') agent.steer(input); else if (message.mode === 'inject') agent.inject(input); else agent.followup(input)
          break
        }
        case 'cancel': agentOf(message.sessionId).cancel({ kind: 'user' }); break
        case 'trust': { const session = agentOf(message.sessionId).session; trust(session); send({ t: 'trusted', sessionId: message.sessionId, preset: presetOf(session) }); break }
        case 'untrust': { const session = agentOf(message.sessionId).session; ctx.get('permissionPresets')?.set(session, 'workspace-write'); send({ t: 'trusted', sessionId: message.sessionId, preset: presetOf(session) }); break }
        case 'approval-answer': { const settle = approvals.get(message.id); if (settle) { approvals.delete(message.id); settle(message.outcome) } break }
        case 'lca-result': {
          const call = calls.get(message.id)
          if (!call) break
          calls.delete(message.id)
          if (message.ok) call.done(message.value ?? null, message.source ?? null); else call.fail(new Error(message.error ?? 'LCA tool failed'))
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

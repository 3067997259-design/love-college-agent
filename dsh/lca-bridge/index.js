// lca-bridge: lets the LCA main process drive DSH agents over the Node IPC channel it opened.
// It contributes her persona per agent, exposes LCA's own tools, forwards session activity for the
// book UI, and sends every approval to LCA. Out-of-tree plugin: DSH imports resolve through the
// profile runtime, so it shares the installation's single Cordis instance.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'lca-bridge'
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'systemPrompt', 'tools', 'approval']

const CLIP = 4000
// Commands that change things outside ordinary project work. Asking for these is a courtesy layer on
// top of the sandbox, not a security boundary: the list cannot recognise every equivalent command.
const RISKY = [
  /\brm\s+-[a-z]*r/i, /\bremove-item\b[^|;]*-recurse/i, /\b(del|erase)\b[^|;]*\s\/s\b/i, /\b(rd|rmdir)\b[^|;]*\s\/s\b/i,
  /\bformat(-volume)?\s/i, /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)\b/i, /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\b(stop-computer|restart-computer|shutdown)\b/i, /\b(reg(\.exe)?\s+(add|delete)|set-executionpolicy)\b/i,
  /\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^\n]*\|\s*(iex|invoke-expression|sh|bash)\b/i,
]

export function apply(ctx) {
  if (typeof process.send !== 'function') throw new Error('lca-bridge needs the IPC channel of its LCA parent')
  const send = (message) => { if (process.connected) process.send(message) }
  const live = new Map() // sessionId -> { handle, cwd }
  const approvals = new Map()
  const calls = new Map()
  const asked = new Map() // callId -> risky command this plugin asked about
  // LCA's private data (journals, connection settings) and the DSH home are never her working material.
  const guarded = (process.env.LCA_GUARDED_ROOTS ?? '').split(';').filter(Boolean).map((root) => resolve(root).toLowerCase())
  let persona = ''
  let suffix = ''
  let toolDisposers = []

  const idOf = (agent) => (agent ? String(agent.id) : '')
  const owned = (agent) => live.has(idOf(agent))
  const texts = (blocks) => (blocks ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
  const clip = (value) => (value.length > CLIP ? value.slice(0, CLIP) + '…' : value)
  const plain = (value) => JSON.parse(JSON.stringify(value ?? null))

  const registerLcaTools = (tools) => {
    for (const dispose of toolDisposers) dispose()
    toolDisposers = tools.map((tool) => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      execute: (args, exec) => new Promise((done, fail) => {
        const id = randomUUID()
        calls.set(id, { done, fail })
        exec.signal?.addEventListener('abort', () => { if (calls.delete(id)) fail(new Error('cancelled')) }, { once: true })
        send({ t: 'lca-call', id, sessionId: idOf(exec.agent), callId: String(exec.callId), name: tool.name, args: plain(args) })
      }),
    }))
  }

  // Only LCA decides trust, and only for a project the user granted in the book.
  const trust = (session) => {
    const presets = ctx.get('permissionPresets')
    if (!presets) throw new Error('lca-bridge: permission presets unavailable')
    presets.set(session, 'lca-trusted')
  }

  const open = async ({ sessionId, cwd, trusted }) => {
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
    return { sessionId: String(id), cwd, provider: selection.provider, model: selection.model, preset: ctx.get('permissionPresets')?.current(handle.agent.session) ?? null }
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

  // Third-party-free policy layer: refuse LCA's private roots, ask before risky commands.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!owned(exec.agent)) return next()
    const args = JSON.stringify(exec.arguments ?? {}).toLowerCase().replaceAll('\\\\', '\\')
    if (guarded.some((root) => args.includes(root) || args.includes(root.replaceAll('\\', '/')))) return { kind: 'deny', reason: 'This path is LCA private data; she does not work on it.' }
    const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
    if (command && RISKY.some((pattern) => pattern.test(command))) {
      asked.set(String(exec.callId), command)
      return { kind: 'ask', reason: `Risky command: ${command.slice(0, 200)}` }
    }
    return next()
  })

  ctx.on('approval/request', async (request, next) => {
    if (!owned(request.agent)) return next()
    const id = randomUUID()
    const callId = request.callId ? String(request.callId) : null
    const risky = callId ? asked.get(callId) ?? null : null
    if (callId) asked.delete(callId)
    send({ t: 'approval', id, sessionId: idOf(request.agent), toolName: request.toolName, callId, reason: request.reason ?? null, kind: risky ? 'risky' : 'escalation', command: risky })
    return await new Promise((settle) => {
      approvals.set(id, settle)
      request.signal?.addEventListener('abort', () => { if (approvals.delete(id)) settle('cancelled') }, { once: true })
    })
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!owned(agent) || frame.type !== 'chunk') return
    if (frame.chunk.type === 'text-delta' && frame.chunk.text) send({ t: 'delta', sessionId: idOf(agent), text: frame.chunk.text })
  })

  ctx.on('agent/error', ({ agent, error }) => {
    if (owned(agent)) send({ t: 'agent-error', sessionId: idOf(agent), message: error instanceof Error ? error.message : String(error) })
  })

  ctx.on('session/event', (session, event) => {
    const entry = [...live].find(([, value]) => value.handle.agent.session === session)
    if (!entry) return
    const sessionId = entry[0]
    const data = event.data
    switch (event.type) {
      case 'turn/start': send({ t: 'turn-start', sessionId, turn: data.turn }); break
      case 'user/message': send({ t: 'user-message', sessionId, kind: data.source?.kind ?? null, chars: texts(data.content).length }); break
      case 'turn/end': send({ t: 'turn-end', sessionId, turn: data.turn, reason: plain(data.reason) }); break
      case 'assistant/message': {
        const toolCalls = (data.message.content ?? []).filter((block) => block.type === 'tool-call').map((block) => ({ id: String(block.id), name: block.name, arguments: clip(block.arguments ?? '') }))
        send({ t: 'message', sessionId, turn: data.turn, step: data.step, text: texts(data.message.content), toolCalls, usage: plain(data.usage) })
        break
      }
      case 'tool/call': send({ t: 'tool-call', sessionId, callId: String(data.callId), name: data.name, args: clip(data.arguments) }); break
      case 'tool/result': send({ t: 'tool-result', sessionId, callId: String(data.message.toolCallId), isError: !!data.message.isError, text: clip(texts(data.message.content)), error: plain(data.error) }); break
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
        case 'trust': { const session = agentOf(message.sessionId).session; trust(session); send({ t: 'trusted', sessionId: message.sessionId, preset: ctx.get('permissionPresets')?.current(session) ?? null }); break }
        case 'approval-answer': { const settle = approvals.get(message.id); if (settle) { approvals.delete(message.id); settle(message.outcome) } break }
        case 'lca-result': {
          const call = calls.get(message.id)
          if (!call) break
          calls.delete(message.id)
          if (message.ok) call.done(message.value ?? null); else call.fail(new Error(message.error ?? 'LCA tool failed'))
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

// Test-only Cordis observer. Mounted only in a temporary profile by dsh-family-check.mjs.
// No production IPC handlers, shell tools, credentials or application data are used here.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
export const name = 'lca-family-probe'
export const inject = ['agents', 'tools', 'subagents', 'sessionProjections']
export function apply(ctx) {
  const agents = new Map()
  const ended = new Map()
  const waiting = new Set()
  const held = new Map()
  const released = new Set()
  const compacted = new Set()
  const send = (value) => { if (process.connected) process.send({ t: 'probe', ...value }) }
  const policy = (session) => {
    let approval = null
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq)
      if (event?.type === 'approval/policy') { approval = event.data.policy; break }
    }
    return { approval, preset: ctx.get('permissionPresets')?.current(session) ?? null }
  }
  ctx.on('agent/created', ({ agent, source }) => {
    agents.set(String(agent.id), agent)
    send({ event: 'created', id: String(agent.id), parent: agent.session.header.parentSession ?? null, cwd: agent.session.header.cwd, source, ...policy(agent.session) })
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const session = payload.agent.session
    if (process.env.LCA_FAMILY_COMPACT === '1' && session.header.parentSession && payload.step === 2 && !compacted.has(String(session.id))) {
      const nodes = [...session.surface.nodes]
      const end = nodes.findLast((seq) => session.eventAt(seq)?.type === 'tool/result')
      const start = nodes.findLast((seq) => seq < end && session.eventAt(seq)?.type === 'assistant/message')
      if (start !== undefined && end !== undefined) {
        session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'compaction' }, content: [{ type: 'text', text: 'SUMMARY_MARKER derived from FAMILY_RAW_SOURCE' }] }, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: nodes.filter((seq) => seq >= start && seq <= end) })
        compacted.add(String(session.id)); send({ event: 'summary', id: String(session.id) })
      }
    }
    let originalStillInLog = false
    for (let seq = 0; seq < session.seq; seq++) if (/FAMILY_(RAW|RELAY|SETTLED)_SOURCE/.test(JSON.stringify(session.eventAt(seq)))) originalStillInLog = true
    send({ event: 'original-log', id: String(payload.agent.id), originalStillInLog })
    send({ event: 'step', id: String(payload.agent.id), parent: payload.agent.session.header.parentSession ?? null, turn: payload.turn, step: payload.step, ...policy(payload.agent.session) })
    try { return await next() }
    catch (error) { send({ event: 'pre-step-error', id: String(payload.agent.id), error: String(error), stack: error.stack }); throw error }
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      ended.set(String(session.id), (ended.get(String(session.id)) ?? 0) + 1)
      for (const notify of waiting) notify()
    }
    if (['tool/result', 'user/message', 'turn/end', 'approval/resolved'].includes(event.type)) {
      send({ event: event.type, id: String(session.id), data: event.data })
    }
  })
  ctx.on('tools/pre-execute', (exec, next) => exec.name === 'family_ask' ? { kind: 'ask', reason: 'Synthetic per-member approval probe; no external action.' } : next())
  const tool = (name, parameters, execute) => ctx.tools.register({ name, description: 'Isolated LCA regression fixture.', parameters, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute })
  tool('mcp__family__read', {}, async () => ({ text: 'FAMILY_RAW_SOURCE' }))
  tool('family_ask', {}, async (_args, exec) => { send({ event: 'effect', id: String(exec.agent.id), callId: String(exec.callId) }); return { approved: true } })
  tool('family_hold', {}, async (_args, exec) => {
    if (released.has(String(exec.agent.id))) return { released: true }
    await new Promise((done, fail) => {
      const id = String(exec.agent.id), abort = () => { held.delete(id); fail(new Error('cancelled')) }
      held.set(id, () => { exec.signal?.removeEventListener('abort', abort); done() })
      exec.signal?.addEventListener('abort', abort, { once: true })
    })
    return { released: true }
  })
  const control = (message) => { if (message?.t === 'probe-release') { released.add(message.id); held.get(message.id)?.(); held.delete(message.id) } }
  process.on('message', control); ctx.effect(() => () => process.off('message', control))
  tool('family_late', { id: { type: 'string', required: true } }, async (args, exec) => {
    exec.agent.steer({ id: randomUUID(), role: 'user', source: { kind: 'agent-message', form: 'relay', senderSessionId: args.id }, content: [{ type: 'text', text: 'Message from member:' }, { type: 'text', text: 'FAMILY_RELAY_SOURCE' }] })
    return { queued: true }
  })
  tool('family_foreign', {}, async (_args, exec) => {
    const cwd = resolve(exec.agent.session.header.cwd, '..', 'foreign-project'); mkdirSync(cwd, { recursive: true })
    const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd, parentSession: exec.agent.session.id }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    send({ event: 'foreign', id: String(handle.agent.id) })
    const done = new Promise((settle) => {
      const dispose = ctx.on('session/event', (session, event) => { if (session.id === handle.agent.session.id && event.type === 'turn/end') { dispose(); settle() } })
    })
    handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: '[[FOREIGN]] must never reach a model' }], source: { kind: 'user' } })
    await done; await handle.dispose()
    return { checked: true }
  })
  tool('family_acl', {}, async () => { throw new Error('SetNamedSecurityInfoW failed (Win32 5): grantWrite(synthetic fixture)') })
  tool('family_wait', { id: { type: 'string', required: true }, count: { type: 'number', required: true } }, async (args, exec) => {
    await new Promise((done, fail) => {
      let timer
      const finish = (error) => { waiting.delete(check); clearTimeout(timer); exec.signal?.removeEventListener('abort', abort); if (error) fail(error); else done() }
      const check = () => { if ((ended.get(args.id) ?? 0) >= args.count) finish() }
      const abort = () => finish(new Error('fixture cancelled'))
      timer = setTimeout(() => finish(new Error('fixture child did not settle')), 15_000)
      waiting.add(check); exec.signal?.addEventListener('abort', abort, { once: true }); check()
    })
    return { settled: true }
  })
  tool('family_inspect', {}, async (_args, exec) => {
    const manager = ctx.get('pluginManager')
    const result = {
      tools: exec.agent.ctx.tools.schemas().map((tool) => tool.name),
      manager: ['listPlugins', 'listBundles', 'inspect', 'setPluginEnabled', 'setBundleEnabled', 'installBundle', 'waitForInstall', 'cancelInstall', 'removeBundle'].filter((key) => typeof manager?.[key] === 'function'),
    }
    send({ event: 'inspect', ...result })
    return { inspected: true }
  })
}

// Test-only Cordis observer. Mounted only in a temporary profile by dsh-family-check.mjs.
// No production IPC handlers, shell tools, credentials or application data are used here.
import { RETIREMENT_KEY, retireReferences, retireResults, staleEntries } from '../../dsh/lca-bridge/policy.js'
export const name = 'lca-family-probe'
export const inject = ['agents', 'tools', 'subagents', 'sessionProjections']
export function apply(ctx) {
  const agents = new Map()
  const ended = new Map()
  const waiting = new Set()
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
    // Candidate seam only: test that the public lifecycle event runs after delegation seeding,
    // before the first request, and again on cold resume. Not a production safety fix.
    if (process.env.LCA_FAMILY_SEAM === 'candidate' && agent.session.header.parentSession) agent.session.append('approval/policy', { policy: 'ask' })
  })
  ctx.on('agent/pre-step', (payload, next) => {
    if (process.env.LCA_FAMILY_SEAM === 'candidate') {
      const session = payload.agent.session
      const stale = staleEntries(ctx.sessionProjections.stateOf(session, RETIREMENT_KEY))
      const references = retireReferences(session, stale.filter((entry) => entry.kind === 'reference'))
      const results = retireResults(session, stale.filter((entry) => entry.kind === 'result'), ctx.get('tokenMeter'))
      // Synthetic markers stand in for the durable provenance ledger P2 must implement. This
      // proves the supported replacement seam, NOT provenance tracking or compaction safety.
      let messages = 0
      if (payload.turn > 1) for (const seq of [...session.surface.nodes]) {
        const event = session.eventAt(seq)
        if (event?.type !== 'user/message' || !['agent-message', 'subagent-settled'].includes(event.data.source?.kind)) continue
        if (!JSON.stringify(event.data.content).match(/FAMILY_(RELAY|SETTLED)_SOURCE/)) continue
        session.append('user/message', { ...event.data, content: [{ type: 'text', text: '[Synthetic earlier member source retired]' }] }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
        messages++
      }
      let originalStillInLog = false
      for (let seq = 0; seq < session.seq; seq++) if (/FAMILY_(RAW|RELAY|SETTLED)_SOURCE/.test(JSON.stringify(session.eventAt(seq)))) originalStillInLog = true
      send({ event: 'retirement-seam', id: String(payload.agent.id), references, results, messages, originalStillInLog })
    }
    send({ event: 'step', id: String(payload.agent.id), parent: payload.agent.session.header.parentSession ?? null, turn: payload.turn, step: payload.step, ...policy(payload.agent.session) })
    return next()
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
  tool('family_ask', {}, async () => ({ approved: true }))
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

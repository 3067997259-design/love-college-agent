// Main-issued project authority, member-scoped approvals and durable source retirement.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SOURCE_KEY, SOURCE_RETIRED, createSourceMailbox, incomingBody, retireSources, sourceProjection, sourcesIn } from './provenance.js'

export function createFamilySafety(ctx, { originOf, send, sourceOf, onWaiting = () => {} }) {
  ctx.sessionProjections.register(sourceProjection(sourceOf))
  let mailbox
  try { mailbox = createSourceMailbox(join(process.env.DSH_HOME, 'lca-source-mailbox.json')) } catch { /* open reports a closed failure, rather than leaving main waiting for hello */ }
  const roots = new Map(), members = new Map(), pending = new Map(), reported = new Map()
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return { ...assembly, contexts: assembly.contexts.map((entry) => entry.name === 'subagent:delegation' ? {
      ...entry, name: 'lca:delegation', text: 'You are an LCA delegated member. LCA owns project trust and per-action approvals. Approval requests go to the user in the book, independently of the lead agent. Do not change permissions yourself or retry declined actions. Ordinary questions still go through the lead agent.',
    } : entry) }
  })
  const state = (agent) => ctx.sessionProjections.stateOf(agent.session, SOURCE_KEY)
  const sources = (agent) => sourcesIn(state(agent))
  const recordSource = (exec, source) => appendPluginRecord(exec.agent.session, 'plugin:lca/tool-source', { callId: String(exec.callId), sources: source ? [source] : [] })
  const applyPolicy = (agent, root) => {
    const presets = ctx.get('permissionPresets')
    if (!presets) throw new Error('LCA_PERMISSION_SERVICE_UNAVAILABLE')
    // set also repairs a delegated `never` override even if the preset name already matches.
    presets.set(agent.session, root.trusted ? 'lca-trusted' : 'workspace-write')
  }
  const ensure = (agent, resumed = false) => {
    if (!mailbox) throw new Error('LCA_SOURCE_MAILBOX_UNAVAILABLE')
    const origin = originOf(agent), root = roots.get(origin?.rootSessionId)
    if (!origin || !root) throw new Error('LCA_FAMILY_UNAVAILABLE')
    let member = members.get(origin.sessionId)
    if (!member) {
      const parent = members.get(origin.parentSessionId)
      member = { agent, origin, scope: { rootSessionId: origin.rootSessionId, project: origin.cwd, authorizationId: origin.parentSessionId && resumed ? state(agent).scope?.authorizationId ?? 'unverified' : parent?.scope.authorizationId ?? root.authorizationId },
        inherited: parent ? [...new Set([...sources(parent.agent), ...(state(parent.agent).entries.some((entry) => entry.reference) ? ['member'] : [])])] : [], activationId: randomUUID(), turn: null, initialized: false }
      members.set(origin.sessionId, member)
    }
    if (member.agent !== agent) { member.agent = agent; member.activationId = randomUUID(); member.turn = null }
    applyPolicy(agent, root)
    return { member, root }
  }
  const cancelApprovals = (rootId) => { for (const request of [...pending.values()]) if (request.rootId === rootId) request.cancel() }
  const announce = (rootId) => { const root = roots.get(rootId), agent = ctx.agents.get(rootId); if (root && agent) send({ t: 'family-policy', origin: originOf(agent), revision: root.revision, stopped: root.stopped }) }
  const setTrust = (rootId, trusted) => {
    const root = roots.get(rootId)
    if (!root) throw new Error('LCA_FAMILY_UNAVAILABLE')
    if (!trusted) {
      cancelApprovals(rootId); root.revision++; root.stopped = true
      for (const member of members.values()) if (member.origin.rootSessionId === rootId) member.agent.cancel({ kind: 'user' })
    }
    root.trusted = trusted
    for (const member of members.values()) if (member.origin.rootSessionId === rootId) applyPolicy(member.agent, root)
    announce(rootId)
  }
  const retiredMessage = (message) => ({ ...message, content: [{ type: 'text', text: SOURCE_RETIRED }], source: { ...message.source, lcaProvenance: { retired: true } } })
  const prepare = (member, root, messages) => messages.map((message) => {
    if (message.source?.lcaProvenance?.retired) return message
    const incoming = incomingBody(message)
    if (incoming) {
      const lease = mailbox.lookup(incoming.sender, incoming.kind, incoming.body, { ...member.scope, authorizationId: root.authorizationId }, member.origin.sessionId)
      if (!lease) return retiredMessage(message)
      if (member.stopped && (!member.resume || member.resume.sender !== incoming.sender || member.resume.body !== incoming.body)) return retiredMessage(message)
      member.stopped = false; member.resume = null
      member.scope.authorizationId = root.authorizationId
      return { ...message, source: { ...message.source, lcaProvenance: lease } }
    }
    if (member.origin.parentSessionId && !member.initialized && message.source?.kind === 'user') {
      return { ...message, source: { ...message.source, lcaProvenance: { authorizationId: member.scope.authorizationId, sources: member.inherited } } }
    }
    return message
  })
  const request = (agent, input, signal) => {
    const { member, root } = ensure(agent)
    if (signal?.aborted || member.stopped || root.stopped || member.scope.authorizationId !== root.authorizationId) return Promise.resolve('cancelled')
    const id = randomUUID(), revision = root.revision, activationId = member.activationId
    return new Promise((resolve) => {
      const finish = (outcome) => {
        if (!pending.delete(id)) return
        onWaiting(member.origin.sessionId, null)
        signal?.removeEventListener('abort', cancel)
        resolve(!root.stopped && !member.stopped && revision === root.revision && activationId === member.activationId && member.scope.authorizationId === root.authorizationId ? outcome : 'cancelled')
      }
      const cancel = () => { send({ t: 'approval-cancel', id }); finish('cancelled') }
      pending.set(id, { rootId: member.origin.rootSessionId, memberId: member.origin.sessionId, finish, cancel })
      onWaiting(member.origin.sessionId, 'approval')
      signal?.addEventListener('abort', cancel, { once: true })
      send({ ...input, t: 'approval', id, approvalId: id, activationId, policyRevision: revision, sessionId: member.origin.rootSessionId, origin: member.origin })
    })
  }
  ctx.on('agent/created', ({ agent, source }) => { if (originOf(agent)) ensure(agent, source === 'resume') })
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const { member, root } = ensure(payload.agent)
      if (root.stopped || payload.signal?.aborted) return { kind: 'reject' }
      if (member.turn !== payload.turn) { member.activationId = randomUUID(); member.turn = payload.turn }
      prepare(member, root, payload.messages)
      if (member.stopped || member.scope.authorizationId !== root.authorizationId) return { kind: 'reject' }
      let count = retireSources(payload.agent.session, state(payload.agent), member.scope.authorizationId)
      const decision = await next()
      if (root.stopped || member.stopped || payload.signal?.aborted || member.scope.authorizationId !== root.authorizationId) return { kind: 'reject' }
      // Compaction is another pre-step handler. Its output inherits the provenance of its inputs.
      count += retireSources(payload.agent.session, state(payload.agent), member.scope.authorizationId)
      if (decision.kind === 'enter') decision.messages = prepare(member, root, decision.messages)
      member.initialized = true
      if (count && !member.origin.parentSessionId) send({ t: 'retired', sessionId: member.origin.rootSessionId, count })
      return decision
    } catch { return { kind: 'reject' } } // unreadable projection/mailbox never becomes a clean context
  }, { prepend: true })
  // DSH has opened the step here, but has not projected or sent model input.
  // session/event observers cannot append recursively and contain their errors;
  // the request waterfall allows durable retirement and fails the request closed.
  ctx.on('agent/request', async (payload, next) => {
    const { member, root } = ensure(payload.agent)
    if (root.stopped || member.stopped || payload.signal?.aborted || member.scope.authorizationId !== root.authorizationId) throw new Error('LCA_FAMILY_STOPPED')
    const count = retireSources(payload.agent.session, state(payload.agent), member.scope.authorizationId, payload)
    if (count && !member.origin.parentSessionId) send({ t: 'retired', sessionId: member.origin.rootSessionId, count })
    return next()
  }, { prepend: true })
  ctx.on('session/event', (session, event) => {
    if (event.surfaceOp?.op === 'replace') return
    const member = members.get(String(session.id))
    if (!member) return
    if (event.type === 'assistant/message') {
      const text = (event.data.message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
      if (text) mailbox.publish(member.origin.sessionId, 'settled', text, member.scope, sources(member.agent))
    }
    if (['user/message', 'tool/result'].includes(event.type)) {
      const current = sources(member.agent)
      const key = [...current].sort().join(',')
      if (current.length && !member.origin.parentSessionId && reported.get(member.origin.rootSessionId) !== key) {
        reported.set(member.origin.rootSessionId, key); send({ t: 'degraded', sessionId: member.origin.rootSessionId, sources: current })
      }
    }
  })
  return {
    bind: (rootId, trusted) => {
      if (!mailbox) throw new Error('LCA_SOURCE_MAILBOX_UNAVAILABLE')
      cancelApprovals(rootId); roots.set(rootId, { trusted: trusted === true, revision: 0, stopped: false, authorizationId: randomUUID() })
    },
    ensure, sources, request, setTrust, recordSource,
    /** Read-only observers can reconstruct current source restrictions without activating a cold member. */
    sourcesFromEvents(events) {
      const projection = sourceProjection(sourceOf)
      return sourcesIn(events.reduce((state, event) => projection.apply(state, event), projection.init()))
    },
    status(agent) { const { member, root } = ensure(agent); return { authorized: !root.stopped && !member.stopped && member.scope.authorizationId === root.authorizationId, activationId: member.activationId, sources: sources(agent) } },
    relay(agent, text) { const { member } = ensure(agent); mailbox.publish(member.origin.sessionId, 'relay', text, member.scope, sources(agent)) },
    userMessage(agent, text) { const { member, root } = ensure(agent); if (root.stopped) throw new Error('LCA_FAMILY_STOPPED'); mailbox.publish(member.origin.sessionId, 'relay', text, { ...member.scope, authorizationId: root.authorizationId }, []) },
    expectMessage(id, sender, body) { const member = members.get(id); if (member) member.resume = { sender, body } },
    stopMember(id) {
      const member = members.get(id)
      if (member) { member.stopped = true; member.resume = null; member.activationId = randomUUID() }
      mailbox.retireRecipient(id)
      for (const request of [...pending.values()]) if (request.memberId === id) request.cancel()
    },
    answer: (id, outcome) => pending.get(id)?.finish(outcome === 'allowed-once' ? outcome : 'rejected'),
    begin(agent, renew) {
      const { member, root } = ensure(agent)
      if (renew || root.stopped) {
        cancelApprovals(member.origin.rootSessionId)
        reported.delete(member.origin.rootSessionId)
        // A new user authorization ends old members' in-flight waits/retries as well as their
        // next-step eligibility. Already issued external effects are not claimed to be undone.
        for (const previous of members.values()) if (previous.origin.rootSessionId === member.origin.rootSessionId && previous.origin.parentSessionId) previous.agent.cancel({ kind: 'user' })
        root.revision++; root.authorizationId = randomUUID(); root.stopped = false
      }
      member.scope.authorizationId = root.authorizationId
      announce(member.origin.rootSessionId)
      return root.authorizationId
    },
    beforeTool(exec) {
      const { member, root } = ensure(exec.agent)
      if (root.stopped || member.stopped || member.scope.authorizationId !== root.authorizationId || exec.signal?.aborted) return false
      recordSource(exec, sourceOf(String(exec.name)))
      if (String(exec.name) === 'send_message' && typeof exec.arguments?.message === 'string') mailbox.publish(member.origin.sessionId, 'relay', exec.arguments.message, member.scope, sources(exec.agent))
      return true
    },
    cancel(rootId) {
      const root = roots.get(rootId)
      if (!root) return
      root.stopped = true; root.revision++; cancelApprovals(rootId)
      for (const member of members.values()) if (member.origin.rootSessionId === rootId) member.agent.cancel({ kind: 'user' })
      announce(rootId)
    },
  }
}

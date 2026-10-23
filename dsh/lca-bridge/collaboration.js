import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { COLLABORATION_KEY, RETIRED_TASK, cleanLine, collaborationProjection, taskVisible, nextTaskLease, turnOutcome } from './collaboration-state.js'

const POLICY = `LCA collaboration: choose by coordination needs, not task size. Use subagent for a self-contained deliverable, subagent_fork only when completed conversation context is needed. Use spawn_teammate when stable responsibilities, peer messages, shared task claims or dependencies are needed. Reuse suitable existing members before creating more. Do not create a team for every small step. Root may delegate independent helper work alongside a team; helpers cannot claim Team tasks. Do not increase delegation depth.
Use list_agents before creating members. Team roster capacity is permanent for this root session (failed creation also consumes a name/slot); interrupt and inactivity do not free it. Ordinary and Team members share resident execution capacity. Do not interpret running count as available slots. If full, reuse a suitable member or explicitly delegate independent work; do not silently downgrade work requiring Team membership.
Use the opaque target returned by tools, never invent names or addresses. send_message accepts work, not completion. inactive does not mean success; interrupt requests stopping, not deletion. Shared tasks: list/get, claim current revision, work, verify results, complete. Dependencies do not wake owners. Write scopes are advisory, not locks. Coordinate scripts/formatters and review final changes. Before wait_agent ensure a required peer is running; message inactive peers before waiting. The lead verifies required results before final delivery. A new user turn retires old member authorizations; explicitly send fresh instructions to continue. Never copy retired task text into a new task.`
const string = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const integer = (description, required = false) => ({ type: 'integer', description, ...(required ? { required: true } : {}) })
const strings = { type: 'array', items: { type: 'string' } }
const output = { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

export function createCollaboration(ctx, { originOf, safety, send, roots, onHumanMessage }) {
  ctx.sessionProjections.register(collaborationProjection())
  ctx.systemPrompt.section({ name: 'lca:collaboration', order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'), text: POLICY, interpolate: false })
  const revisions = new Map(), rendered = new Map(), pending = new Map(), stopping = new Set(), waiting = new Map()
  let scheduled = false, closed = false
  const rootOf = (agent) => { const origin = originOf(agent); const root = origin && ctx.agents.get(origin.rootSessionId); if (!root) throw new Error('LCA_COLLABORATION_UNAVAILABLE'); return root }
  const state = (root) => ctx.sessionProjections.stateOf(root.session, COLLABORATION_KEY)
  const stamp = (root, kind, id, value) => appendPluginRecord(root.session, 'plugin:lca/collaboration', { kind, id, value })
  const lease = (agent) => { const { member, root } = safety.ensure(agent); return { authorizationId: member.scope.authorizationId, sources: safety.sources(agent), current: root.authorizationId, stopped: root.stopped } }
  const recordMember = (agent, patch) => {
    const origin = originOf(agent)
    if (!origin || !origin.parentSessionId) return
    const root = rootOf(agent), previous = state(root).members[origin.sessionId]
    stamp(root, 'member', origin.sessionId, { ...(previous ?? lease(agent)), ...patch })
  }
  const check = (agent) => { const value = lease(agent); if (value.stopped || value.authorizationId !== value.current) throw new Error('LCA_MEMBER_REQUIRES_NEW_INSTRUCTION') }
  const roster = (agent) => ctx.agentTeams.listMembers(agent)
  const rawTasks = (root) => ctx.agentTeams.listTasks(root)
  const taskForModel = (agent, task, exec) => {
    const root = rootOf(agent), allowed = taskVisible(task, state(root).tasks[task.id], lease(agent).current)
    if (allowed) {
      if (exec) for (const source of state(root).tasks[task.id].sources) safety.recordSource(exec, source)
      const projected = { ...task }
      if (task.ownerName) { const owner = roster(agent).find((member) => member.name === task.ownerName); if (owner) projected.ownerName = `team:${owner.id}`; else delete projected.ownerName }
      return projected
    }
    const retired = { ...task, subject: RETIRED_TASK, description: RETIRED_TASK, writeScopes: [], writeScopeWarnings: [], sourceStatus: 'retired' }
    delete retired.ownerName
    return retired
  }
  const address = (origin, id, parent) => ({ runtimeId: origin.runtimeId, projectId: origin.projectId, rootSessionId: origin.rootSessionId, sessionId: id, parentSessionId: parent })
  const targetOf = (entry) => `${entry.team ? 'team' : 'agent'}:${entry.id}`
  const entries = async (caller, signal) => {
    const children = await ctx.subagents.listDescendants(caller.id, signal)
    const membership = ctx.agentTeams.tryMembership(caller)
    const team = membership ? roster(caller) : []
    const rows = new Map(children.filter((row) => row.kind !== 'diagnostic').map((row) => [String(row.id), { ...row, parent: String(row.parentId ?? caller.id), team: false }]))
    for (const member of team) rows.set(String(member.id), { ...rows.get(String(member.id)), ...member, team: true, parent: member.role === 'lead' ? null : String(membership.root.id), mode: member.phase === 'failed' ? 'unknown' : 'continuable' })
    // Ordinary members retain only their real parent/descendant authority.
    if (!membership && caller.session.header.parentSession) {
      const parent = ctx.agents.get(caller.session.header.parentSession)
      if (parent) rows.set(String(parent.id), { id: String(parent.id), parent: parent.session.header.parentSession ?? null, mode: 'parent', team: false })
    }
    return [...rows.values()]
  }
  const resolveTarget = async (caller, target, signal) => {
    const found = (await entries(caller, signal)).find((entry) => targetOf(entry) === target)
    if (!found) throw new Error('LCA_MEMBER_TARGET_UNAVAILABLE')
    return found
  }
  const controlTarget = async (args, exec) => {
    if (!!args.target === !!args.agent_id) throw new Error('LCA_EXACTLY_ONE_TARGET')
    if (args.target) return args.target
    const entry = (await entries(exec.agent, exec.signal)).find((row) => String(row.id) === args.agent_id)
    if (!entry) throw new Error('LCA_MEMBER_TARGET_UNAVAILABLE')
    return targetOf(entry)
  }
  const message = async (caller, target, text, signal, human = false) => {
    if (!human) check(caller)
    const entry = await resolveTarget(caller, target, signal)
    if (String(entry.id) === String(caller.id) || (!entry.team && entry.mode !== 'parent' && entry.parent !== String(caller.id))) throw new Error('LCA_MEMBER_MESSAGE_RELATION')
    const provenance = human ? safety.userMessage(caller, text) : safety.relay(caller, text)
    safety.expectMessage(String(entry.id), String(caller.id), text)
    if (human) onHumanMessage(String(rootOf(caller).id))
    if (entry.team) await ctx.agentTeams.sendMessage(caller, { target: entry.name, content: [{ type: 'text', text }], signal })
    else await ctx.subagents.sendMessage(caller, entry.id, [{ type: 'text', text }], { signal })
    void provenance
    notify()
    return { accepted: true, target, processed: false }
  }
  const interrupt = async (caller, target, signal) => {
    const entry = await resolveTarget(caller, target, signal)
    if (String(entry.id) === String(caller.id) || entry.mode === 'parent') throw new Error('LCA_MEMBER_STOP_RELATION')
    if (entry.team) ctx.agentTeams.interrupt(caller, entry.name)
    else ctx.subagents.interrupt(entry.id, { kind: 'ancestor', agent: caller })
    safety.stopMember(String(entry.id))
    if (ctx.agents.get(entry.id)?.status === 'running') stopping.add(String(entry.id))
    notify(); return { accepted: true, stopped: false }
  }
  const capacity = (root) => ({ teamUsed: roster(root).length - 1, teamLimit: ctx.agentTeams.config.maxMembers, resident: null, activeLimit: ctx.subagents.config.maxActiveSubagents.get() })
  const snapshot = async (root) => {
    const origin = originOf(root)
    if (!origin) throw new Error('LCA_COLLABORATION_UNAVAILABLE')
    const rows = await entries(root), saved = state(root), authorization = lease(root).current
    const origins = [], members = rows.filter((row) => row.id !== root.id)
    members.unshift({ id: root.id, parent: null, team: true, name: 'lead', mode: 'root' })
    const publicMembers = members.map((row, index) => {
      const id = String(row.id), live = ctx.agents.get(row.id), fact = saved.members[id], allowed = !!fact?.labelLease && fact.labelLease.sources.length === 0
      const memberAddress = address(origin, id, row.parent)
      origins.push({ ...memberAddress, protocolVersion: 2, cwd: origin.cwd })
      const current = live ? safety.status(live) : { authorized: false, sources: [] }
      const failed = row.status === 'failed'
      const activity = failed ? 'unavailable' : stopping.has(id) && live?.status === 'running' ? 'stopping' : live?.status === 'running' ? waiting.has(id) || !current.authorized ? 'waiting' : 'running' : 'inactive'
      const item = { address: memberAddress, mode: row.mode === 'root' ? 'root' : row.team ? 'teammate' : row.mode === 'one-shot' ? 'fork' : 'subagent',
        name: index === 0 ? '主角色' : allowed ? cleanLine(row.name ?? row.label) || `协作者 ${index}` : `协作者 ${index}`,
        taskLabel: allowed ? cleanLine(row.description ?? row.label) || null : null, activity,
        outcome: failed ? 'failed' : fact?.outcome ?? 'none', waitingFor: waiting.get(id) ?? (!current.authorized && index !== 0 ? 'user' : null),
        controls: { message: index !== 0 && !lease(root).stopped && !failed && (row.team || row.parent === String(root.id) && row.mode === 'continuable'), interrupt: index !== 0 && live?.status === 'running' },
        usage: { admittedUnits: fact?.admittedUnits ?? 0, inputTokens: fact?.inputTokens ?? null, outputTokens: fact?.outputTokens ?? null },
        sources: { status: !fact && index !== 0 ? 'unverified' : (current.sources.length || fact?.sources.length) ? 'restricted' : 'clean', kinds: [...new Set([...(fact?.sources ?? []), ...current.sources])] },
        resultText: fact?.sources.length === 0 ? fact.resultText ?? null : null, activityLabel: live?.status === 'running' ? fact?.activityLabel ?? null : null, error: null }
      // Tool activity and token counters must not invalidate a stop/message aimed at the same activation.
      const encoded = JSON.stringify({ address: item.address, mode: item.mode, controls: item.controls, activity: item.activity, authorized: current.authorized, activationId: current.activationId })
      if (rendered.get(id) !== encoded) { rendered.set(id, encoded); revisions.set(id, (revisions.get(id) ?? 0) + 1) }
      return { ...item, revision: revisions.get(id) }
    })
    const tasks = rawTasks(root).map((task) => {
      const metadata = saved.tasks[task.id], visible = taskVisible(task, metadata, authorization) && metadata.sources.length === 0
      return { id: task.id, rootSessionId: String(root.id), revision: task.revision, subject: visible ? cleanLine(task.subject) : '来源内容已收起',
        ownerSessionId: rows.find((row) => row.team && row.name === task.ownerName)?.id ?? null,
        status: ({ pending: 'open', in_progress: 'claimed', completed: 'completed', deleted: 'deleted' })[task.status], blockedBy: task.blockedBy,
        writeScopeLabels: visible ? task.writeScopes.map((scope) => cleanLine(scope)) : [], scopeOverlap: task.writeScopeWarnings.length > 0, sourceStatus: visible ? 'available' : 'retired' }
    })
    const receipt = saved.operations?.[saved.lastOperation]
    const operation = receipt?.phase === 'running' && ![...pending.values()].some((entry) => entry.requestId === receipt.requestId)
      ? { ...receipt, phase: 'settled', outcome: 'unknown' } : receipt ?? null
    return { origins, view: { status: 'ready', runtimeId: origin.runtimeId, projectId: origin.projectId, members: publicMembers, tasks, capacity: capacity(root), operation } }
  }
  function notify() {
    if (scheduled || closed) return
    scheduled = true
    queueMicrotask(async () => {
      scheduled = false
      for (const root of roots()) {
        try { const value = await snapshot(root); if (!closed) send({ t: 'collaboration', sessionId: String(root.id), ...value }) } catch { /* explicit refresh reports failure; never project a partial board */ }
      }
    })
  }
  const taskUpdate = async (agent, args, exec) => {
    check(agent)
    const root = rootOf(agent), previous = state(root).tasks[args.task_id], current = lease(agent)
    const task = await ctx.agentTeams.updateTask(agent, { taskId: args.task_id, expectedRevision: args.expected_revision, action: args.action,
      ...(args.subject === undefined ? {} : { subject: args.subject }), ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by }), ...(args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes }),
      ...(args.owner === undefined ? {} : { owner: (await resolveTarget(agent, args.owner)).name }) })
    // Another member may have persisted a newer revision while the DSH update was pending.
    // Merge its lease now; never regress the revision or discard its source restrictions.
    stamp(root, 'task', task.id, nextTaskLease(state(root).tasks[task.id] ?? previous, current, task.revision)); await ctx.sessions.flush(root.session); notify()
    return taskForModel(agent, task, exec)
  }
  const register = (name, description, parameters, run) => ctx.tools.register({ name, description, parameters: { type: 'object', properties: Object.fromEntries(Object.entries(parameters).map(([key, value]) => { const schema = { ...value }; delete schema.required; return [key, schema] })), required: Object.entries(parameters).filter(([, value]) => value.required).map(([key]) => key), additionalProperties: false }, output,
    execute: async (args, exec) => {
      try { check(exec.agent); return await run(args, exec) }
      catch (error) {
        const code = /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'LCA_COLLABORATION_FAILED'
        // Never attach the upstream cause: it can quote retired task text or private member names.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(code === 'TEAM_MEMBER_LIMIT' ? `${code}: roster full; reuse a suitable member or explicitly delegate independent helper work. Stopping does not free slots.` : code)
      }
    } })
  register('list_agents', 'List authorized ordinary children and Team peers with opaque targets and distinct roster/resident limits. inactive is not completion.', { scope: string('children or descendants; authority is always checked') }, async (_args, exec) => ({ self: String(exec.agent.id), members: (await entries(exec.agent, exec.signal)).map((entry) => {
    const metadata = state(rootOf(exec.agent)).members[String(entry.id)]?.labelLease
    const visible = metadata && (metadata.sources.length === 0 || metadata.authorizationId === lease(exec.agent).current)
    if (visible) for (const source of metadata.sources) safety.recordSource(exec, source)
    return { target: targetOf(entry), id: entry.id, mode: entry.team ? entry.role : entry.mode, status: entry.status ?? (ctx.agents.get(entry.id)?.status === 'running' ? 'running' : 'inactive'), label: visible ? cleanLine(entry.name ?? entry.label) : 'member' }
  }), capacity: capacity(rootOf(exec.agent)) }))
  register('send_message', 'Continue an existing member using its exact target. Acceptance is not a reply. Ordinary messages require a direct parent/child relationship.', { target: string('Opaque target returned by list_agents or spawn_teammate'), agent_id: string('Compatibility: exact session id; relationship still checked'), message: string('Fresh explicit instructions; never replay retired source text', true) }, async (args, exec) => message(exec.agent, await controlTarget(args, exec), args.message, exec.signal))
  register('interrupt_agent', 'Request a member to stop. Does not free Team roster slots or prove termination.', { target: string('Opaque target'), agent_id: string('Compatibility: descendant session id') }, async (args, exec) => interrupt(exec.agent, await controlTarget(args, exec), exec.signal))
  register('spawn_teammate', 'Create a stable named Team member only when shared task claims, peer messages or dependencies are needed. Prefer reusing suitable members. Roster slots cannot be recycled.', { name: string('Unique lower-kebab-case name', true), description: string('Stable responsibility', true), prompt: string('Complete initial task', true), context: { type: 'string', enum: ['fresh', 'fork'] } }, async (args, exec) => {
    const root = rootOf(exec.agent)
    if (String(root.id) !== String(exec.agent.id)) throw new Error('TEAM_LEAD_REQUIRED')
    try { const result = await ctx.agentTeams.spawnTeammate(exec.agent, { name: args.name, description: args.description, prompt: [{ type: 'text', text: args.prompt }], context: args.context ?? 'fresh', provider: args.context === 'fork' ? 'fork' : 'spawn', signal: exec.signal }); return { member: { target: `team:${result.member.id}`, status: result.member.status } } }
    finally { notify() }
  })
  register('team_task_create', 'Create a shared Team task. Ordinary helpers are not Team owners.', { subject: string('Task subject', true), description: string('Task and verification criteria', true), blocked_by: strings, write_scopes: strings }, async (args, exec) => {
    const root = rootOf(exec.agent), metadata = lease(exec.agent)
    const task = await ctx.agentTeams.createTask(exec.agent, { subject: args.subject, description: args.description, blockedBy: args.blocked_by, writeScopes: args.write_scopes })
    stamp(root, 'task', task.id, { ...metadata, revision: task.revision }); await ctx.sessions.flush(root.session); notify(); return taskForModel(exec.agent, task, exec)
  })
  register('team_task_get', 'Read the current task revision and source-safe text.', { task_id: string('Task id', true) }, (args, exec) => taskForModel(exec.agent, ctx.agentTeams.getTask(exec.agent, args.task_id), exec))
  register('team_task_list', 'List shared tasks before claiming. Ready dependencies do not wake their owners.', {}, (_args, exec) => ({ tasks: ctx.agentTeams.listTasks(exec.agent).map((task) => taskForModel(exec.agent, task, exec)) }))
  register('team_task_update', 'Compare-and-set a shared task using its current revision; task completion requires actual work evidence.', { task_id: string('Task id', true), expected_revision: integer('Revision from get/list', true), action: { type: 'string', enum: ['claim', 'release', 'complete', 'reopen', 'edit', 'reassign', 'delete'], required: true }, subject: string('Replacement subject'), description: string('Replacement description'), blocked_by: strings, write_scopes: strings, owner: string('Opaque Team target for reassign') }, (args, exec) => taskUpdate(exec.agent, args, exec))
  register('wait_agent', 'Wait for Team activity only when another needed member is running. Does not start inactive members.', { timeout_ms: integer('10000 through 60000 milliseconds') }, async (args, exec) => {
    if (!roster(exec.agent).some((row) => row.id !== exec.agent.id && ['running', 'provisioning'].includes(row.status))) return { noProgress: true }
    return ctx.agentTeams.waitForChange(exec.agent, Math.min(60_000, Math.max(10_000, args.timeout_ms ?? 10_000)), exec.signal)
  })
  ctx.on('agent/created', ({ agent, source }) => {
    if (source !== 'resume' && originOf(agent)?.parentSessionId) recordMember(agent, { ...lease(agent), labelLease: lease(agent), outcome: 'none', resultText: null })
    notify()
  })
  ctx.on('agent/status', ({ agent }) => { if (agent.status !== 'running') stopping.delete(String(agent.id)); notify() })
  ctx.on('session/event', (session, event) => {
    if (event.surfaceOp?.op === 'replace') return
    const agent = ctx.agents.get(session.id)
    if (!agent || !originOf(agent)) return
    const origin = originOf(agent)
    if (origin.parentSessionId) {
      if (event.type === 'turn/start') recordMember(agent, { ...lease(agent), outcome: 'none', resultText: null })
      if (event.type === 'tool/call') recordMember(agent, { activityLabel: cleanLine(event.data.name, 80) })
      if (event.type === 'assistant/message') {
        const prior = state(rootOf(agent)).members[String(agent.id)] ?? {}, usage = event.data.usage
        const sources = safety.sources(agent), blocks = event.data.message.content ?? []
        recordMember(agent, { ...lease(agent), resultText: sources.length || blocks.some((block) => block.type === 'tool-call') ? null : cleanLine(blocks.filter((block) => block.type === 'text').map((block) => block.text).join(''), 2000), inputTokens: (prior.inputTokens ?? 0) + (usage?.inputTokens ?? 0), outputTokens: (prior.outputTokens ?? 0) + (usage?.outputTokens ?? 0) })
      }
      if (event.type === 'turn/end') { recordMember(agent, { outcome: turnOutcome(event.data.reason?.kind), activityLabel: null }); waiting.delete(String(agent.id)) }
    }
    if (['team/member', 'team/task', 'turn/start', 'turn/end', 'tool/call', 'assistant/message', 'plugin:lca/collaboration'].includes(event.type)) notify()
  })
  return {
    notify,
    waiting: (id, reason) => { if (reason) waiting.set(id, reason); else waiting.delete(id); notify() },
    admitted: (agent, units) => { if (originOf(agent)?.parentSessionId) { const previous = state(rootOf(agent)).members[String(agent.id)]; recordMember(agent, { admittedUnits: (previous?.admittedUnits ?? 0) + units }) } },
    async request({ rootSessionId, command, requestId = randomUUID() }) {
      const root = roots().find((agent) => String(agent.id) === rootSessionId)
      if (!root) throw new Error('LCA_COLLABORATION_UNAVAILABLE')
      const before = await snapshot(root)
      if (command.type !== 'agent.refresh') {
        if (state(root).operations?.[requestId]) return snapshot(root)
        const target = before.view.members.find((member) => JSON.stringify(member.address) === JSON.stringify(command.target.address) && (['agent.stop-family', 'team.task.update'].includes(command.type) ? member.mode === 'root' : member.revision === command.target.expectedRevision))
        if (!target) throw new Error('LCA_STALE_MEMBER')
        const targetId = `${target.mode === 'root' || target.mode === 'teammate' ? 'team' : 'agent'}:${target.address.sessionId}`
        const signal = new AbortController(); pending.set(signal, { rootSessionId, requestId })
        stamp(root, 'operation', requestId, { requestId, phase: 'running', outcome: 'pending', error: null }); await ctx.sessions.flush(root.session)
        try {
          if (command.type === 'agent.message') { if (!target.controls.message) throw new Error('LCA_MEMBER_MESSAGE_RELATION'); await message(root, targetId, command.text, signal.signal, true) }
          else if (command.type === 'agent.interrupt') await interrupt(root, targetId, signal.signal)
          else if (command.type === 'agent.stop-family') safety.cancel(rootSessionId)
          else if (command.type === 'team.task.update') { if (target.mode !== 'root') throw new Error('TEAM_LEAD_REQUIRED'); await taskUpdate(root, { task_id: command.taskId, expected_revision: command.expectedTaskRevision, action: command.action }) }
          else throw new Error('LCA_COLLABORATION_COMMAND')
          stamp(root, 'operation', requestId, { requestId, phase: 'settled', outcome: 'accepted', error: null }); await ctx.sessions.flush(root.session)
        } catch (error) {
          // A send failure may have followed inbox acceptance. Preserve pending for read-only reconciliation.
          if (command.type !== 'agent.message') { stamp(root, 'operation', requestId, { requestId, phase: 'settled', outcome: 'failed', error: null }); await ctx.sessions.flush(root.session) }
          throw error
        } finally { pending.delete(signal); notify() }
      }
      return snapshot(root)
    },
    close() { closed = true; for (const signal of pending.keys()) signal.abort(); pending.clear() },
  }
}
import { randomUUID } from 'node:crypto'

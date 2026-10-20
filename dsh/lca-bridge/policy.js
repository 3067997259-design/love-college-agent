// lca-bridge policy: pure pieces of the bridge's tool policy, kept apart so they can be tested without
// a DSH runtime. Sessions and agents are only read through the fields named here.

// Commands that change things outside ordinary project work. Asking for these is a courtesy layer on
// top of the sandbox, not a security boundary: the list cannot recognise every equivalent command.
export const RISKY = [
  /\brm\s+-[a-z]*r/i, /\bremove-item\b[^|;]*-recurse/i, /\b(del|erase)\b[^|;]*\s\/s\b/i, /\b(rd|rmdir)\b[^|;]*\s\/s\b/i,
  /\bformat(-volume)?\s/i, /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)\b/i, /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\b(stop-computer|restart-computer|shutdown)\b/i, /\b(reg(\.exe)?\s+(add|delete)|set-executionpolicy)\b/i,
  /\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^\n]*\|\s*(iex|invoke-expression|sh|bash)\b/i,
]
export const isRisky = (command) => !!command && RISKY.some((pattern) => pattern.test(command))

// D2: results from these tools are third-party originals. While one is in her context, writing,
// running commands and reaching outside need the user's approval each time, and no grant applies.
const SOURCE_TOOLS = { web_fetch: 'web', web_search: 'web', read_mcp_resource: 'mcp', list_mcp_resources: 'mcp', list_mcp_resource_templates: 'mcp' }
export const sourceOf = (name) => SOURCE_TOOLS[name] ?? (name.startsWith('mcp__') ? 'mcp' : null)
const GATED = new Set(['write', 'edit', 'pwsh', 'bash', 'web_fetch', 'web_search', 'read_mcp_resource'])
export const gatedWhileDegraded = (name) => GATED.has(name) || name.startsWith('mcp__')
// A helper's answer can carry what it read, so a delegation result in a degraded turn retires too.
export const DELEGATION = new Set(['subagent', 'subagent_fork', 'workflow'])

// Her chat and work models (LCA settings). A turn starts on the chat model. Her first hands-on step
// moves the turn to the work model: a step that changes things is not run but decided again by the
// work model, so the code it writes is the work model's own; a step that only looks runs as asked.
// Helpers inherit the model of the request that spawned them, so they run on the work model too.
const HANDS_ON = new Set(['write', 'edit', 'pwsh', 'bash', 'todo_write', 'create_goal', 'subagent', 'subagent_fork', 'workflow', 'send_message'])
const LOOKING = new Set(['read', 'read_image', 'glob', 'grep', 'working_directory'])
export const handoffOf = (name) => HANDS_ON.has(name) ? 'redo' : LOOKING.has(name) ? 'switch' : null
export const HANDOFF_FEEDBACK = 'Not run: the work model takes over this turn from here. Decide this step again yourself, then carry on with the work.'
export const sameModel = (a, b) => a.provider === b.provider && a.model === b.model && (a.effort ?? null) === (b.effort ?? null)
/** LCA's routes from the launch environment (src/main/dsh/routes.ts); null keeps DSH's default model. */
export const parseRoutes = (text) => {
  try {
    const value = JSON.parse(text ?? '')
    const valid = (route) => typeof route?.provider === 'string' && typeof route?.model === 'string'
    return valid(value?.chat) && valid(value?.work) ? { chat: value.chat, work: value.work } : null
  } catch { return null }
}

// DSH's Windows ACL sandbox needs permission to change the workspace's permissions. Where the folder
// does not allow that (seen on a D: root without WRITE_DAC), every sandboxed command fails like this.
const SANDBOX_DENIED = /SetNamedSecurityInfoW failed \(Win32 5\)|\bgrantWrite\(/
const textOfResult = (result) => [...(result?.content ?? []).map((block) => block?.text ?? ''), String(result?.error?.message ?? '')].join('\n')
export const sandboxDenied = (result) => result?.isError === true && SANDBOX_DENIED.test(textOfResult(result))
// What she reads instead of the raw ACL error, so she never sets out to repair folder permissions.
export const TRUST_FEEDBACK = {
  trusted: 'The user has just trusted this project: from now on your commands here run without the OS sandbox (risky commands still ask first). Run the same command again.',
  declined: 'Commands cannot run in this folder: the OS sandbox does not work here on this computer, and the user chose not to let commands run outside it. Do not change folder permissions or ask for escalation. Tell the user briefly what you could not run; you can still read and edit the project files.',
  degraded: 'Commands cannot run in this folder: the OS sandbox does not work here on this computer. This turn read third-party content, so the user cannot trust the project right now. Do not change folder permissions. Tell the user they can grant trust if they ask you again in a new message.',
}

export const subjectOf = (args) => {
  for (const key of ['command', 'file_path', 'path', 'url', 'query']) if (typeof args?.[key] === 'string' && args[key].trim()) return args[key].slice(0, 200)
  return null
}

/**
 * Subagents and teammates belong to the root session that spawned them. A child is seen through its
 * parent's tool call first, so one hop per lookup is enough to place every descendant.
 */
export function createLineage(isRoot) {
  const family = new Map()
  const sid = (agent) => String(agent?.session?.id ?? '')
  const rootOf = (agent) => {
    const id = sid(agent)
    if (!id) return null
    if (isRoot(id)) return id
    const known = family.get(id)
    if (known) return known
    const parent = agent.session.header?.parentSession
    if (parent === undefined || parent === null) return null
    const root = isRoot(String(parent)) ? String(parent) : family.get(String(parent)) ?? null
    if (root) family.set(id, root)
    return root
  }
  return { sid, rootOf }
}

/**
 * Per root session: which third-party sources are in her context and since which turn. While any are, writes,
 * commands and fetches ask the user each time. A later turn retires the originals first (the retirement projection
 * below knows them, also after a restart) and is then no longer degraded.
 */
export function createDegradation() {
  const roots = new Map()
  return {
    active: (root) => (roots.get(root)?.sources.size ?? 0) > 0,
    sources: (root) => [...(roots.get(root)?.sources ?? [])],
    /** @returns whether the set of sources grew, so the journal records it once per source. */
    mark(root, source, turn) {
      let value = roots.get(root)
      if (!value) roots.set(root, value = { sources: new Set(), turn })
      const grew = !value.sources.has(source)
      value.sources.add(source)
      value.turn = turn
      return grew
    },
    /** Sources LCA saw in her context before a restart: settled at her next turn's first step. */
    restore(root, sources) { if (sources.length) roots.set(root, { sources: new Set(sources), turn: null }) },
    /** The state to settle at the first step of a turn after the one that read third-party content. */
    due(root, turn) { const value = roots.get(root); return value && value.turn !== turn ? value : null },
    carry(root, turn) { const value = roots.get(root); if (value) value.turn = turn },
    clear(root) { roots.delete(root) },
  }
}

export const RETIRED = 'LCA retired this earlier third-party result (web page, search or external tool output) from the conversation. Fetch it again if it is still needed.'

/**
 * Replace tool results on the model-visible surface, the way DSH's tool-result pruner does: a shadow-price event for
 * the token meter, then a single-node surface replacement.
 * @returns how many results were replaced; ones no longer on the surface (compacted) are skipped.
 */
export function retireResults(session, entries, meter) {
  const nodes = new Set(session.surface.nodes)
  let count = 0
  for (const entry of entries) {
    if (!nodes.has(entry.seq)) continue
    const original = entry.data.message
    const message = { ...original, content: [{ type: 'text', text: RETIRED }] }
    if (meter) session.append('compaction/prune', { shadowedRange: { start: entry.seq, end: entry.seq }, shadowedSeqs: [entry.seq], shadowedTokenCount: meter.estimateMessage(original) })
    session.append('tool/result', { ...entry.data, message }, { surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq }, sourceEventSeqs: [entry.seq] })
    count++
  }
  return count
}

// LCA's references (memories, her world, your files, an old-page quote, an original you asked to see) ride in front
// of your words in a turn's opening message. They are current only for that turn, like the legacy loop's per-request
// state, so the next turn replaces them in her context with this note and keeps your words.
export const REFERENCE_RETIRED = '[LCA references for an earlier turn, retired: they were current only then.]\n\n'

/**
 * What a later turn retires from her context, folded from the session log so it is known after a restart too:
 * opening messages that carry LCA references (the bridge marks them on their source; DSH keeps a source's own
 * fields), results of source tools, and helpers' answers in a turn that had read one (they can carry what was read).
 * Turns are counted in the log itself: `turns` is how many have started, and an entry belongs to the turn it arrived in.
 * @param sourceOf - tool name to its third-party source, or null for an ordinary tool.
 */
export const RETIREMENT_KEY = 'lca-retirement'
const validRetirement = (value) => Number.isSafeInteger(value?.turns) && typeof value.read === 'boolean' && !!value.calls && typeof value.calls === 'object' && Array.isArray(value.open)
  && value.open.every((entry) => Number.isSafeInteger(entry?.seq) && Number.isSafeInteger(entry?.turn) && (entry.kind === 'reference' ? Array.isArray(entry.data?.content) : entry.kind === 'result' && !!entry.data?.message))
export function retirementProjection(sourceOf) {
  return {
    key: RETIREMENT_KEY,
    stateVersion: 1,
    stateSchema: { parse(value) { if (!validRetirement(value)) throw new Error('lca-retirement: malformed projection state'); return value } },
    // `calls`: tool names of calls still waiting for their result; `read`: this turn has read a third-party source.
    init: () => ({ turns: 0, read: false, calls: {}, open: [] }),
    apply(state, event) {
      if (event.type === 'turn/start') return { ...state, turns: state.turns + 1, read: false }
      const op = event.surfaceOp
      // Retired here, or folded away by compaction: either way the original is no longer on the surface.
      if (op?.op === 'replace') {
        const covered = (entry) => entry.seq >= op.startSeq && entry.seq <= op.endSeq
        return state.open.some(covered) ? { ...state, open: state.open.filter((entry) => !covered(entry)) } : state
      }
      if (event.type === 'tool/call') return { ...state, calls: { ...state.calls, [String(event.data?.callId)]: String(event.data?.name ?? '') } }
      if (event.type === 'tool/result') {
        const callId = String(event.data?.message?.toolCallId ?? event.data?.callId)
        if (!(callId in state.calls)) return state
        const { [callId]: name, ...calls } = state.calls
        const source = sourceOf(name)
        const carries = !!source || DELEGATION.has(name) && (state.read || state.open.some((entry) => entry.kind === 'result'))
        if (!carries) return { ...state, calls }
        return { ...state, calls, read: state.read || !!source, open: [...state.open, { seq: event.seq, turn: state.turns, kind: 'result', data: event.data }] }
      }
      if (event.type !== 'user/message' || event.data?.source?.lcaReferences !== true) return state
      // Only your words are kept: the retired message is the note and then them.
      const source = { ...event.data.source }
      delete source.lcaReferences
      return { ...state, open: [...state.open, { seq: event.seq, turn: state.turns, kind: 'reference', data: { ...event.data, source, content: (event.data.content ?? []).slice(1) } }] }
    },
  }
}
/** Entries of earlier turns than the current one. */
export const staleEntries = (state) => (state?.open ?? []).filter((entry) => entry.turn < state.turns)
export function retireReferences(session, entries) {
  const nodes = new Set(session.surface.nodes)
  let count = 0
  for (const entry of entries) {
    if (!nodes.has(entry.seq)) continue
    session.append('user/message', { ...entry.data, content: [{ type: 'text', text: REFERENCE_RETIRED }, ...entry.data.content] }, { surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq }, sourceEventSeqs: [entry.seq] })
    count++
  }
  return count
}

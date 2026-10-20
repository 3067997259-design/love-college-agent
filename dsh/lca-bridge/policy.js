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
 * Per root session: which third-party sources are in her context, since which turn, and the captured
 * result events to retire. A later turn retires them first, like LCA's own historical-result
 * retirement. Without captured events (state restored after a restart) the session stays degraded.
 */
export function createDegradation() {
  const roots = new Map()
  const entry = (root, turn) => {
    let value = roots.get(root)
    if (!value) roots.set(root, value = { sources: new Set(), turn, pending: new Map(), sticky: false })
    return value
  }
  return {
    active: (root) => (roots.get(root)?.sources.size ?? 0) > 0,
    sources: (root) => [...(roots.get(root)?.sources ?? [])],
    /** @returns whether the set of sources grew, so the journal records it once per source. */
    mark(root, source, turn) {
      const value = entry(root, turn)
      const grew = !value.sources.has(source)
      value.sources.add(source)
      value.turn = turn
      return grew
    },
    restore(root, sources) { if (sources.length) roots.set(root, { sources: new Set(sources), turn: null, pending: new Map(), sticky: true }) },
    capture(root, event) { roots.get(root)?.pending.set(event.seq, event) },
    /** The state to settle at the first step of a turn after the one that read third-party content. */
    due(root, turn) { const value = roots.get(root); return value && value.turn !== turn ? value : null },
    carry(root, turn) { const value = roots.get(root); if (value) value.turn = turn },
    clear(root) { roots.delete(root) },
  }
}

export const RETIRED = 'LCA retired this earlier third-party result (web page, search or external tool output) from the conversation. Fetch it again if it is still needed.'

/**
 * Replace captured tool results on the model-visible surface, the way DSH's tool-result pruner does:
 * a shadow-price event for the token meter, then a single-node surface replacement.
 * @returns how many results were replaced; ones no longer on the surface (compacted) are skipped.
 */
export function retireResults(session, events, meter) {
  const nodes = new Set(session.surface.nodes)
  let count = 0
  for (const event of events) {
    if (!nodes.has(event.seq)) continue
    const original = event.data.message
    const message = { ...original, content: [{ type: 'text', text: RETIRED }] }
    if (meter) session.append('compaction/prune', { shadowedRange: { start: event.seq, end: event.seq }, shadowedSeqs: [event.seq], shadowedTokenCount: meter.estimateMessage(original) })
    session.append('tool/result', { ...event.data, message }, { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
    count++
  }
  return count
}

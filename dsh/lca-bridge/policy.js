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
const SOURCE_TOOLS = { web_fetch: 'web', web_search: 'web', read_mcp_resource: 'mcp', list_mcp_resources: 'mcp', list_mcp_resource_templates: 'mcp', skill: 'plugin' }
export const sourceOf = (name) => SOURCE_TOOLS[name] ?? (name.startsWith('mcp__') ? 'mcp' : null)
const GATED = new Set(['write', 'edit', 'pwsh', 'bash', 'web_fetch', 'web_search', 'read_mcp_resource'])
export const gatedWhileDegraded = (name) => GATED.has(name) || name.startsWith('mcp__') || name.startsWith('lca_') || name === 'plugin_manager'
// A helper's answer can carry what it read, so a delegation result in a degraded turn retires too.
export const DELEGATION = new Set(['subagent', 'subagent_fork', 'spawn_teammate', 'workflow'])

// Her chat and work models (LCA settings). A turn starts on the chat model. Her first hands-on step
// moves the turn to the work model: a step that changes things is not run but decided again by the
// work model, so the code it writes is the work model's own; a step that only looks runs as asked.
// Helpers inherit the model of the request that spawned them, so they run on the work model too.
const HANDS_ON = new Set(['write', 'edit', 'pwsh', 'bash', 'todo_write', 'create_goal', 'subagent', 'subagent_fork', 'workflow', 'send_message', 'spawn_teammate', 'team_task_create', 'team_task_update'])
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

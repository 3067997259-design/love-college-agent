import { isAbsolute, relative, resolve } from 'node:path'
import { cleanLine } from './collaboration-state.js'

export const MEMBER_STEPS_KEY = 'lca-member-steps-v1'
const MAX_STEPS = 12
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0
const argsOf = (value) => {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
/** Allowlisted summaries only: never content, tool output, URL credentials/query, or an outside-project path. */
export function stepTarget(tool, input, cwd) {
  const args = argsOf(input)
  if (['read', 'read_image', 'write', 'edit'].includes(tool)) {
    const file = args.file_path ?? args.path
    if (typeof cwd !== 'string' || typeof file !== 'string' || !file.trim()) return undefined
    const path = relative(cwd, resolve(cwd, file))
    if (!path || isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\')) return undefined
    return cleanLine(path.replaceAll('\\', '/'), 200)
  }
  if (['grep', 'glob'].includes(tool)) return cleanLine(args.pattern, 60) || undefined
  if (['bash', 'pwsh'].includes(tool)) return cleanLine(args.command, 80) || undefined
  if (tool === 'web_fetch') {
    try { const url = new URL(args.url); return ['http:', 'https:'].includes(url.protocol) ? cleanLine(url.hostname, 200) : undefined } catch { return undefined }
  }
  return undefined
}

/** DSH keeps this projection in its own session, never as repeated records in the root log. */
export function memberStepsProjection() {
  return {
    key: MEMBER_STEPS_KEY, stateVersion: 1,
    init: (header) => ({ cwd: header?.cwd ?? null, restricted: false, steps: [] }),
    stateSchema: { parse(value) {
      if (!value || typeof value.restricted !== 'boolean' || value.cwd !== null && typeof value.cwd !== 'string' || !Array.isArray(value.steps) || value.steps.length > MAX_STEPS
        || value.steps.some((step) => typeof step.callId !== 'string' || typeof step.tool !== 'string' || step.tool.length > 200
          || !['running', 'completed', 'failed'].includes(step.status) || !timestamp(step.startedAt)
          || step.endedAt !== null && (!timestamp(step.endedAt) || step.endedAt < step.startedAt)
          || step.target !== undefined && (typeof step.target !== 'string' || step.target.length > 200))) throw new Error('LCA_MEMBER_STEPS_INVALID')
      return value
    } },
    apply(state, event) {
      if (event.surfaceOp?.op === 'replace' || !timestamp(event.time)) return state
      const source = (event.data.message ?? event.data).source
      // Retiring a source from model context must not expose old argument summaries in this history.
      if (event.type === 'plugin:lca/tool-source' && event.data.sources?.length
        || event.type === 'user/message' && (source?.lcaProvenance?.sources?.length || ['agent-message', 'team-message', 'subagent-settled'].includes(source?.kind) && !Array.isArray(source?.lcaProvenance?.sources))
        || event.type === 'tool/call' && ['web_fetch', 'web_search'].includes(event.data.name)) state = { ...state, restricted: true }
      if (event.type === 'tool/call') {
        const { callId, name, arguments: args } = event.data
        const target = stepTarget(name, args, state.cwd)
        return { ...state, steps: [...state.steps, { callId: String(callId), tool: cleanLine(name, 200), status: 'running', startedAt: event.time, endedAt: null, ...(target ? { target } : {}) }].slice(-MAX_STEPS) }
      }
      if (event.type === 'tool/result') {
        const message = event.data.message
        return { ...state, steps: state.steps.map((step) => step.callId === String(message.toolCallId) && step.status === 'running'
          ? { ...step, status: message.isError ? 'failed' : 'completed', endedAt: Math.max(step.startedAt, event.time) } : step) }
      }
      return state
    },
  }
}

/** Also consult the current safety lease; a clean name is not evidence of a clean execution. */
export function memberStepsReply(state, fact, current) {
  const allowed = !state.restricted && !!fact?.labelLease && fact.labelLease.sources.length === 0 && fact.sources?.length === 0 && current?.sources.length === 0
  return { withheld: !allowed, steps: state.steps.map(({ tool, status, startedAt, endedAt, target }) => ({ tool, status, startedAt, endedAt, ...(allowed && target ? { target } : {}) })) }
}

/** Ephemeral current step. Sequence changes even if identical calls were coalesced into one view. */
export function nextMemberStep(previous, event, seq) {
  if (event.type === 'turn/end') return null
  if (event.type === 'turn/start') return { tool: null, phase: 'thinking', seq }
  if (event.type === 'tool/call') return { tool: cleanLine(event.data.name, 200), phase: 'tool', seq }
  if (event.type === 'tool/result') return { tool: previous?.tool ?? null, phase: 'thinking', seq }
  if (event.type === 'user/message' && ['agent-message', 'team-message', 'subagent-settled'].includes((event.data.message ?? event.data).source?.kind)) return { tool: previous?.tool ?? null, phase: 'note', seq }
  return previous
}

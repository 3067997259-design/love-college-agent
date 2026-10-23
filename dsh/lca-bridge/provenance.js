// Durable, per-session model-surface provenance. Original events are never deleted.
// No model-authored flag is authority: only bridge-created source metadata and logged tool identity.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const SOURCE_KEY = 'lca-sources-v2'
export const SOURCE_RETIRED = '[LCA retired earlier source-derived content. Read the source again if needed.]'
const kinds = new Set(['mail', 'document', 'web', 'mcp', 'plugin', 'member'])
const unique = (values) => [...new Set(values)]
const text = (blocks) => (blocks ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
const surfaceTypes = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'])
const metadata = (event) => (event.data?.message ?? event.data)?.source?.lcaProvenance
const validLease = (value) => value && typeof value.authorizationId === 'string' && Array.isArray(value.sources) && value.sources.every((source) => kinds.has(source))
const validState = (value) => Number.isSafeInteger(value?.turns) && value.turns >= 0 && value.calls && typeof value.calls === 'object'
  && Array.isArray(value.entries) && value.entries.every((entry) => Number.isSafeInteger(entry.seq) && Number.isSafeInteger(entry.turn) && validLease(entry) && surfaceTypes.has(entry.type))

/** Replayable provenance follows replacements as well as originals. A summary never cleans its inputs. */
export function sourceProjection(sourceOf) {
  return {
    key: SOURCE_KEY, stateVersion: 2,
    stateSchema: { parse(value) { if (!validState(value)) throw new Error('LCA_SOURCE_STATE_INVALID'); return value } },
    init: () => ({ turns: 0, scope: null, calls: {}, entries: [] }),
    apply(state, event) {
      if (event.type === 'turn/start') return { ...state, turns: state.turns + 1 }
      if (event.type === 'user/message' && event.surfaceOp?.op !== 'replace' && validLease(metadata(event))) state = { ...state, scope: { authorizationId: metadata(event).authorizationId } }
      const present = unique(state.entries.flatMap((entry) => entry.sources))
      const auth = state.scope?.authorizationId ?? 'legacy'
      if (event.type === 'plugin:lca/tool-source') {
        const { callId, sources } = event.data
        if (typeof callId !== 'string' || !Array.isArray(sources) || !sources.every((source) => kinds.has(source))) throw new Error('LCA_SOURCE_RECORD_INVALID')
        const call = state.calls[callId] ?? { authorizationId: auth, turn: state.turns, sources: present }
        return { ...state, calls: { ...state.calls, [callId]: { ...call, ownSources: unique([...(call.ownSources ?? []), ...sources]) } } }
      }
      if (event.type === 'tool/call') return { ...state, calls: { ...state.calls, [String(event.data.callId)]: { ...state.calls[String(event.data.callId)], name: event.data.name, authorizationId: auth, turn: state.turns, sources: present } } }
      if (!surfaceTypes.has(event.type)) return state
      const op = event.surfaceOp, info = metadata(event)
      const replaced = op?.op === 'replace' ? state.entries.filter((entry) => entry.seq >= op.startSeq && entry.seq <= op.endSeq || event.sourceEventSeqs?.includes(entry.seq)) : []
      let entries = state.entries.filter((entry) => !replaced.includes(entry)), calls = state.calls
      const retiredResult = event.type === 'tool/result' && op?.op === 'replace' && event.data.message.content?.length === 1 && event.data.message.content[0]?.text === SOURCE_RETIRED
      if (info?.retired === true || retiredResult) return { ...state, entries }
      let sources = [], authorizationId = auth, turn = state.turns, reference = false
      if (replaced.length) {
        sources = unique(replaced.flatMap((entry) => entry.sources)); turn = Math.min(...replaced.map((entry) => entry.turn))
        authorizationId = replaced.every((entry) => entry.authorizationId === replaced[0].authorizationId) ? replaced[0].authorizationId : 'unverified'
        // A replacement can have copied a reference even if it was not third-party evidence.
        reference = replaced.some((entry) => entry.reference)
      } else if (event.type === 'tool/result') {
        const callId = String(event.data.message?.toolCallId), call = calls[callId]
        calls = { ...calls }; delete calls[callId]
        const source = call?.name ? sourceOf(call.name) : null
        const declared = call?.ownSources ?? (source ? [source] : call?.name?.startsWith('lca_') ? ['plugin'] : [])
        sources = unique([...(call?.sources ?? []), ...declared, ...present])
        authorizationId = call?.authorizationId ?? auth; turn = call?.turn ?? state.turns
        reference = state.entries.some((entry) => entry.reference)
      } else if (event.type === 'assistant/message') { sources = present; reference = state.entries.some((entry) => entry.reference) }
      else if (event.type === 'user/message') {
        reference = event.data.source?.lcaReferences === true
        if (validLease(info)) { sources = info.sources; authorizationId = info.authorizationId }
        else if (['agent-message', 'team-message', 'subagent-settled'].includes(event.data.source?.kind)) { sources = ['member']; authorizationId = 'unverified' }
      }
      // Compaction can use indirect dependencies. Unmarked replacement while restricted is conservative.
      if (op?.op === 'replace' && !replaced.length && present.length) sources = unique([...sources, ...present])
      if (sources.length || reference) entries = [...entries, { seq: event.seq, type: event.type, data: event.data, turn, authorizationId, sources, reference }]
      return { ...state, calls, entries }
    },
  }
}

export function retireSources(session, state, authorizationId) {
  if (!validState(state)) throw new Error('LCA_SOURCE_STATE_INVALID')
  let count = 0
  const nodes = new Set(session.surface.nodes)
  const stale = state.entries.filter((entry) => nodes.has(entry.seq) && (entry.turn < state.turns || entry.authorizationId !== authorizationId))
  const removedCalls = new Set(stale.filter((entry) => entry.type === 'assistant/message').flatMap((entry) => (entry.data.message.content ?? []).filter((block) => block.type === 'tool-call').map((block) => String(block.id))))
  for (const entry of stale) {
    const raw = entry.data.message ?? entry.data
    // Preserve the user's own words in a reference message. Derived calls retire together with
    // their results; copied arguments and streams remain only in the original execution log.
    const content = entry.reference && entry.type === 'user/message' && raw.source?.lcaReferences
      ? [{ type: 'text', text: SOURCE_RETIRED }, ...(raw.content ?? []).slice(1)]
      : [{ type: 'text', text: SOURCE_RETIRED }]
    const source = { ...raw.source, lcaProvenance: { retired: true } }; delete source.lcaReferences
    const message = { ...raw, content, ...(entry.type === 'tool/result' ? {} : { source }) }
    // DSH forbids assistant replacements (provider streams cannot cite prior events). Retire a
    // derived assistant and its results as user notices, like compaction; keep clean call/result pairs.
    const notice = entry.type === 'assistant/message' || entry.type === 'tool/result' && removedCalls.has(String(raw.toolCallId))
    const data = notice ? { role: 'user', id: randomUUID(), content, source } : entry.data.message ? { ...entry.data, message } : message
    session.append(notice ? 'user/message' : entry.type, data, { surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq }, sourceEventSeqs: [entry.seq] })
    count++
  }
  return count
}

/** Metadata-only delivery index. Hashes bind exact outgoing text to the sender's authorization at
 * send time, even if it is delivered after a new user turn, process restart or sender reactivation.
 * Missing/ambiguous evidence retires the delivery; it can never renew an old authorization. */
export function createSourceMailbox(file) {
  let records = []
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    if (stored.version !== 1 || !Array.isArray(stored.records) || !stored.records.every((row) => typeof row.key === 'string' && typeof row.root === 'string' && typeof row.project === 'string' && validLease(row))) throw new Error('LCA_SOURCE_MAILBOX_INVALID')
    records = stored.records
  }
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  const key = (sender, kind, body) => `${sender}:${kind}:${hash(body)}`
  return {
    publish(sender, kind, body, scope, sources) {
      const entry = { key: key(sender, kind, body), root: scope.rootSessionId, project: scope.project, authorizationId: scope.authorizationId, sources: unique(sources) }
      if (records.some((row) => JSON.stringify(row) === JSON.stringify(entry))) return
      records = [...records.slice(-4095), entry]
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.${randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, records })); renameSync(temp, file)
    },
    lookup(sender, kind, body, scope) {
      const found = records.filter((row) => row.key === key(sender, kind, body))
      if (!found.length || found.some((row) => row.root !== scope.rootSessionId || row.project !== scope.project || row.authorizationId !== scope.authorizationId)) return null
      return { authorizationId: scope.authorizationId, sources: unique(['member', ...found.flatMap((row) => row.sources)]) }
    },
  }
}

export function incomingBody(message) {
  if (message.source?.kind === 'agent-message') return { sender: String(message.source.senderSessionId), kind: 'relay', body: text(message.content.slice(1)) }
  if (message.source?.kind === 'subagent-settled') {
    const marker = message.content.findIndex((block) => block.type === 'text' && block.text === 'Its closing message:')
    return { sender: String(message.source.senderSessionId), kind: 'settled', body: marker >= 0 ? text(message.content.slice(marker + 1)) : '' }
  }
  return null
}
export const sourcesIn = (state) => unique(state.entries.flatMap((entry) => entry.sources))

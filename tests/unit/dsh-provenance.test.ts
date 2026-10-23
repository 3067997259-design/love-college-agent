import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error -- ESM bridge loaded by the independently pinned DSH runtime.
import { SOURCE_RETIRED, createSourceMailbox, incomingBody, retireSources, sourceProjection, sourcesIn } from '../../dsh/lca-bridge/provenance.js'

const roots: string[] = []
it('keeps pre-interrupt deliveries retired even after a fresh instruction and cold recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-source-test-')); roots.push(root)
  const file = join(root, 'mailbox.json'), scope = { rootSessionId: 'lead', project: 'project', authorizationId: 'current' }
  let mailbox = createSourceMailbox(file)
  mailbox.publish('sender', 'relay', 'late old delivery', scope, ['web'])
  mailbox.retireRecipient('member')
  mailbox.publish('lead', 'relay', 'fresh explicit instruction', scope, [])
  expect(mailbox.lookup('lead', 'relay', 'fresh explicit instruction', scope, 'member')).not.toBeNull()
  expect(mailbox.lookup('sender', 'relay', 'late old delivery', scope, 'member')).toBeNull()
  mailbox = createSourceMailbox(file)
  expect(mailbox.lookup('sender', 'relay', 'late old delivery', scope, 'member')).toBeNull()
  expect(mailbox.lookup('sender', 'relay', 'late old delivery', scope, 'other-member')).not.toBeNull()
})
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-source-test-'))) throw new Error('Unsafe cleanup')
  rmSync(root, { recursive: true, force: true })
} })
const text = (value: string) => [{ type: 'text', text: value }]
function fixture() {
  const projection = sourceProjection((name: string) => name === 'web_fetch' ? 'web' : null)
  let state = projection.init()
  const events: { seq: number; type: string; data: Record<string, unknown>; surfaceOp?: unknown; sourceEventSeqs?: number[] }[] = []
  const nodes: number[] = []
  const session = { surface: { nodes }, append(type: string, data: Record<string, unknown>, options?: { surfaceOp?: { op: string; startSeq: number; endSeq: number }; sourceEventSeqs?: number[] }) {
    const event = { seq: events.length, type, data, surfaceOp: options?.surfaceOp ?? 'append', ...options }
    events.push(event); state = projection.apply(state, event)
    if (type.endsWith('/message') || type === 'tool/result') {
      const op = options?.surfaceOp
      if (op) { const start = nodes.indexOf(op.startSeq), end = nodes.indexOf(op.endSeq); nodes.splice(start, end - start + 1, event.seq) } else nodes.push(event.seq)
    }
    return event.seq
  } }
  const user = (auth = 'grant-1', sources: string[] = []) => session.append('user/message', { role: 'user', content: text('USER_WORDS'), source: { kind: 'user', lcaProvenance: { authorizationId: auth, sources } } })
  const read = () => { session.append('tool/call', { name: 'web_fetch', callId: 'read' }); return session.append('tool/result', { message: { role: 'tool', toolCallId: 'read', source: { kind: 'tool', callId: 'read' }, content: text('RAW_MARKER') } }) }
  return { projection, session, events, user, read, state: () => state, start: () => session.append('turn/start', {}), visible: () => JSON.stringify(nodes.map((seq) => events[seq].data)) }
}

it('retires source-derived assistant arguments, relays and paired results while keeping originals', () => {
  const f = fixture(); f.start(); f.user(); f.read()
  f.session.append('assistant/message', { message: { role: 'assistant', content: [...text('DERIVED_MARKER'), { type: 'tool-call', id: 'write', name: 'write', arguments: '{"text":"RAW_MARKER"}' }] }, stream: ['RAW_MARKER'] })
  f.session.append('tool/call', { name: 'write', callId: 'write' })
  f.session.append('tool/result', { message: { role: 'tool', toolCallId: 'write', content: text('DERIVED_MARKER') } })
  f.session.append('user/message', { role: 'user', source: { kind: 'agent-message' }, content: text('RELAY_MARKER') })
  f.start(); f.user('grant-2')
  expect(retireSources(f.session, f.state(), 'grant-2')).toBe(4)
  expect(f.visible()).not.toMatch(/RAW_MARKER|DERIVED_MARKER|RELAY_MARKER|tool-call/)
  expect(f.visible()).toContain('USER_WORDS'); expect(f.visible()).toContain(SOURCE_RETIRED)
  expect(JSON.stringify(f.events)).toContain('RAW_MARKER')
  expect(sourcesIn(f.state())).toEqual([])
})

it('carries provenance through compaction and replayed fork prefixes with independent turn counters', () => {
  const f = fixture(); f.start(); f.user(); const source = f.read()
  f.session.append('user/message', { role: 'user', content: text('SUMMARY_MARKER') }, { surfaceOp: { op: 'replace', startSeq: source, endSeq: source }, sourceEventSeqs: [source] })
  const replay = f.events.reduce((state, event) => f.projection.apply(state, event), f.projection.init())
  expect(sourcesIn(replay)).toEqual(['web'])
  expect(f.projection.stateSchema.parse(JSON.parse(JSON.stringify(replay)))).toEqual(replay)
  // A new authorization expires a fork's inherited prefix even when its local turn is still 1.
  expect(retireSources(f.session, replay, 'grant-2')).toBe(1)
  expect(f.visible()).not.toContain('SUMMARY_MARKER')
  expect(f.visible()).not.toContain('RAW_MARKER')
})

it('retires old reference blocks and derived text without erasing the user words or trusting reset turn numbers', () => {
  const f = fixture(); f.start()
  f.session.append('user/message', { role: 'user', source: { kind: 'user', lcaReferences: true }, content: [...text('REFERENCE_MARKER'), ...text('USER_WORDS')] })
  f.session.append('assistant/message', { message: { role: 'assistant', content: text('REFERENCE_MARKER in an answer') } })
  f.start(); f.user('grant-2')
  retireSources(f.session, f.state(), 'grant-2')
  expect(f.visible()).not.toContain('REFERENCE_MARKER')
  expect(f.visible()).toContain('USER_WORDS')
  expect(JSON.stringify(f.events)).toContain('REFERENCE_MARKER')
})

it('does not assign late results to the new authorization', () => {
  const f = fixture(); f.start(); f.user(); f.session.append('tool/call', { name: 'web_fetch', callId: 'old' })
  f.start(); f.user('grant-2')
  f.session.append('tool/result', { message: { role: 'tool', toolCallId: 'old', content: text('LATE_MARKER') } })
  expect(f.state().entries.at(-1)).toMatchObject({ authorizationId: 'grant-1', turn: 1 })
  retireSources(f.session, f.state(), 'grant-2')
  expect(f.visible()).not.toContain('LATE_MARKER')
})

it('replays original tool source declarations after plugin removal, and restricts legacy unknown LCA results', () => {
  const f = fixture(); f.start(); f.user()
  f.session.append('tool/call', { name: 'lca_removed_mail', callId: 'mail' })
  f.session.append('plugin:lca/tool-source', { callId: 'mail', sources: ['mail'] })
  f.session.append('tool/result', { message: { toolCallId: 'mail', content: text('MAIL_MARKER') } })
  expect(sourcesIn(f.state())).toEqual(['mail'])
  const replay = f.events.reduce((state, event) => f.projection.apply(state, event), f.projection.init())
  expect(sourcesIn(replay)).toEqual(['mail'])
  const withoutMetadata = f.events.filter((event) => event.type !== 'plugin:lca/tool-source').reduce((state, event) => f.projection.apply(state, event), f.projection.init())
  expect(sourcesIn(withoutMetadata)).toEqual(['plugin'])
  expect(() => f.projection.apply(replay, { type: 'plugin:lca/tool-source', data: { callId: 'x', sources: ['invented'] } })).toThrow('LCA_SOURCE_RECORD_INVALID')
})

it('binds exact relay and settlement text across restart, project boundaries and delayed delivery', () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-source-test-')); roots.push(root)
  const file = join(root, 'mailbox.json'), scope = { rootSessionId: 'root-a', project: 'project-a', authorizationId: 'grant-1' }
  const mailbox = createSourceMailbox(file)
  mailbox.publish('member-a', 'relay', 'PRIVATE_MARKER', scope, ['web'])
  const restored = createSourceMailbox(file)
  expect(restored.lookup('member-a', 'relay', 'PRIVATE_MARKER', scope)?.sources).toEqual(['member', 'web'])
  for (const patch of [{ rootSessionId: 'root-b' }, { project: 'project-b' }, { authorizationId: 'grant-2' }]) expect(restored.lookup('member-a', 'relay', 'PRIVATE_MARKER', { ...scope, ...patch })).toBeNull()
  expect(restored.lookup('member-b', 'relay', 'PRIVATE_MARKER', scope)).toBeNull()
  expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_MARKER')
  restored.publish('member-a', 'relay', 'PRIVATE_MARKER', { ...scope, authorizationId: 'grant-2' }, [])
  // Identical text published under two grants is ambiguous, never silently rebound to the new one.
  expect(restored.lookup('member-a', 'relay', 'PRIVATE_MARKER', { ...scope, authorizationId: 'grant-2' })).toBeNull()
  expect(incomingBody({ source: { kind: 'subagent-settled', senderSessionId: 'child' }, content: [...text('status'), ...text('Its closing message:'), ...text('done')] })).toEqual({ sender: 'child', kind: 'settled', body: 'done' })
  writeFileSync(file, '{"version":1,"records":[{}]}')
  expect(() => createSourceMailbox(file)).toThrow('LCA_SOURCE_MAILBOX_INVALID')
  expect(() => retireSources({ surface: { nodes: [] } }, {}, 'grant')).toThrow('LCA_SOURCE_STATE_INVALID')
})

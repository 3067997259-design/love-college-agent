import { expect, it } from 'vitest'
// @ts-expect-error -- independent DSH ESM bridge.
import { collaborationProjection, nextTaskLease, taskVisible, turnOutcome } from '../../dsh/lca-bridge/collaboration-state.js'
import { collaborationViewSchema, createCollaborationState } from '../../src/main/dsh/collaboration'
import type { AppCommand } from '../../src/shared'
import type { CollaborationView } from '../../src/shared/collaboration'

const address = { runtimeId: 'runtime', projectId: 'project', rootSessionId: 'root', sessionId: 'child', parentSessionId: 'root' }
const view: CollaborationView = { status: 'ready', runtimeId: 'runtime', projectId: 'project', tasks: [], capacity: { teamUsed: 1, teamLimit: 8, resident: null, activeLimit: 8 },
  members: [{ address, revision: 2, mode: 'teammate', name: 'helper', taskLabel: null, activity: 'inactive', outcome: 'completed', waitingFor: null, controls: { message: true, interrupt: false }, usage: { admittedUnits: 20, inputTokens: 2, outputTokens: 3 }, sources: { status: 'clean', kinds: [] }, error: null }] }
const command = (patch = {}): AppCommand => ({ protocolVersion: 1, epoch: 'epoch', requestId: 'request', type: 'agent.message', target: { address, expectedRevision: 2 }, text: 'continue', ...patch } as AppCommand)
const tick = () => new Promise((resolve) => setImmediate(resolve))

it('only credits explicit completion and rejects inconsistent durable receipts', () => {
  expect(turnOutcome('interrupted')).toBe('aborted')
  expect(turnOutcome('max-tokens')).toBe('unknown')
  expect(turnOutcome(undefined)).toBe('unknown')
  expect(turnOutcome('completed')).toBe('completed')
  const projection = collaborationProjection()
  expect(() => projection.stateSchema.parse({ ...projection.init(), operations: { x: { requestId: 'x', phase: 'running', outcome: 'accepted', error: null } }, lastOperation: 'x' })).toThrow()
  expect(() => projection.stateSchema.parse({ ...projection.init(), members: { x: { authorizationId: 'a', sources: [], labelLease: { sources: [] } } } })).toThrow()
})

it('keeps retired task provenance across claims, edits and cold projection replay', () => {
  const projection = collaborationProjection()
  const original = { authorizationId: 'old', sources: ['web'], revision: 1 }
  const next = nextTaskLease(original, { authorizationId: 'new', sources: [] }, 2)
  let state = projection.init()
  state = projection.apply(state, { type: 'plugin:lca/collaboration', data: { kind: 'task', id: 'task-1', value: next } })
  const restored = projection.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  expect(taskVisible({ revision: 2 }, restored.tasks['task-1'], 'new')).toBe(false)
  expect(taskVisible({ revision: 1 }, original, 'old')).toBe(true)
  expect(taskVisible({ revision: 3 }, next, 'old')).toBe(false)
  expect(taskVisible({ revision: 1 }, null, 'new')).toBe(false)
  expect(() => projection.stateSchema.parse({ members: {}, tasks: { bad: { revision: 1 } } })).toThrow()
})

it('a late task update retains the newer revision and the other member source restrictions', () => {
  const newer = { authorizationId: 'old', sources: ['web'], revision: 3 }
  const late = nextTaskLease(newer, { authorizationId: 'current', sources: ['document'] }, 2)
  expect(late).toEqual({ authorizationId: 'old', sources: ['web', 'document'], revision: 3 })
  expect(taskVisible({ revision: 3 }, late, 'current')).toBe(false)
  expect(taskVisible({ revision: 2 }, late, 'old')).toBe(false)
})

it('rejects cross-project/stale targets, blocks pending operations and ignores late completion after reset', async () => {
  let finish!: (view: CollaborationView) => void
  let calls = 0
  const service = createCollaborationState({ run: () => { calls++; return new Promise((resolve) => { finish = resolve }) }, changed() {}, allowed: () => true })
  service.accept(view)
  expect(service.dispatch(command({ target: { address: { ...address, projectId: 'other' }, expectedRevision: 2 } }))).toBe('stale-epoch')
  expect(service.dispatch(command({ target: { address, expectedRevision: 1 } }))).toBe('stale-epoch')
  expect(service.dispatch(command())).toBeUndefined()
  expect(service.dispatch(command())).toBe('unavailable')
  service.reset(true); finish(view); await tick()
  expect(service.view().members).toEqual([])
  expect(service.view().operation?.outcome).toBe('unknown')
  expect(calls).toBe(1)
})

it('unknown actions cannot be replayed and refresh reconciles a durable receipt', async () => {
  let fail = true
  const service = createCollaborationState({ run: async () => { if (fail) throw new Error('DSH_REQUEST_TIMEOUT'); return { ...view, operation: { requestId: 'request', phase: 'settled', outcome: 'accepted', error: null } } }, changed() {}, allowed: () => true })
  service.accept(view); service.dispatch(command()); await tick()
  expect(service.view().operation?.outcome).toBe('unknown')
  expect(service.dispatch(command({ requestId: 'different' }))).toBe('unavailable')
  fail = false
  service.dispatch(command({ requestId: 'refresh', type: 'agent.refresh' })); await tick()
  expect(service.view().operation?.requestId).toBe('request')
  expect(service.view().operation?.outcome).toBe('accepted')
})
it('a receipt flush error after execution remains unknown and blocks another action', async () => {
  const service = createCollaborationState({ run: async () => { throw new Error('LCA_COLLABORATION_OUTCOME_UNKNOWN') }, changed() {}, allowed: () => true })
  service.accept(view); service.dispatch(command()); await tick()
  expect(service.view().operation?.outcome).toBe('unknown')
  expect(service.dispatch(command({ requestId: 'do-not-replay' }))).toBe('unavailable')
})

it('strips undeclared raw transcript fields and rejects invalid public projection values', () => {
  const scoped = { ...view, members: [{ ...view.members[0], mode: 'root', address: { ...address, sessionId: 'root', parentSessionId: null } }, ...view.members] }
  expect(collaborationViewSchema.parse({ ...scoped, transcript: 'private' })).not.toHaveProperty('transcript')
  expect(collaborationViewSchema.safeParse({ ...scoped, tasks: [{ id: 'foreign', rootSessionId: 'other', revision: 1, subject: 'x', ownerSessionId: null, status: 'open', blockedBy: [], writeScopeLabels: [], scopeOverlap: false }] }).success).toBe(false)
  expect(collaborationViewSchema.safeParse({ ...view, members: [{ ...view.members[0], name: 'x\nprivate' }] }).success).toBe(false)
  const service = createCollaborationState({ run: async () => view, changed() {}, allowed: () => false })
  service.accept(view); expect(service.dispatch(command())).toBe('permission-denied')
})

it('rejects a late member-detail read after the active collaboration scope is reset', async () => {
  let finish!: (value: { withheld: boolean; steps: [] }) => void
  const service = createCollaborationState({ run: async () => view, changed() {}, allowed: () => true,
    readMemberSteps: () => new Promise((done) => { finish = done }) })
  service.accept(view)
  const reading = service.readMemberSteps(address)
  service.reset(); finish({ withheld: false, steps: [] })
  await expect(reading).rejects.toThrow('LCA_MEMBER_STEPS_UNAVAILABLE')
  expect(service.view().operation).toBeNull()
})

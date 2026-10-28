import { describe, expect, it } from 'vitest'
import { assignSlots, poseOf, teamActive, teamMembers, TEAM_SLOTS } from '../../src/renderer/src/book/team/teamScene'
import type { AgentView, CollaborationView } from '../../src/shared/collaboration'

const member = (id: string, patch: Partial<AgentView> = {}): AgentView => ({
  address: { runtimeId: 'r', projectId: 'p', rootSessionId: 'root', sessionId: id, parentSessionId: 'root' },
  revision: 1, mode: 'teammate', name: id, taskLabel: null, activity: 'inactive', outcome: 'none', waitingFor: null,
  controls: { message: true, interrupt: true }, usage: { admittedUnits: 0, inputTokens: null, outputTokens: null },
  sources: { status: 'clean', kinds: [] }, error: null, ...patch,
})
const view = (members: AgentView[], status: CollaborationView['status'] = 'ready'): CollaborationView => ({ status, runtimeId: 'r', projectId: 'p', members, tasks: [] })

describe('who stands in the team room', () => {
  it('shows her helpers, not her, and not members DSH can no longer reach', () => {
    const shown = teamMembers(view([member('root', { mode: 'root' }), member('a'), member('b', { activity: 'unavailable' })]))
    expect(shown.map((m) => m.name)).toEqual(['a'])
    expect(teamMembers(view([member('a')], 'recovering'))).toEqual([])
    expect(teamMembers(undefined)).toEqual([])
  })
  it('counts the team as active only while someone starts, works, waits or is being stopped', () => {
    expect(teamActive([member('a'), member('b', { outcome: 'completed' })])).toBe(false)
    for (const activity of ['starting', 'running', 'waiting', 'stopping'] as const) expect(teamActive([member('a', { activity })])).toBe(true)
  })
})

describe('pose from facts', () => {
  it('draws work, waiting and its reason', () => {
    expect(['typing', 'reading', 'carrying']).toContain(poseOf(member('a', { activity: 'running' })))
    expect(poseOf(member('a', { activity: 'running' }))).toBe(poseOf(member('a', { activity: 'running', revision: 9 })))
    expect(new Set([0, 1, 2].map((place) => poseOf(member('a', { activity: 'running' }), place))).size).toBe(3)
    expect(poseOf(member('a', { activity: 'waiting', waitingFor: 'approval' }), 1)).toBe('waiting')
    expect(poseOf(member('a', { activity: 'waiting', waitingFor: 'approval' }))).toBe('waiting')
    expect(poseOf(member('a', { activity: 'waiting', waitingFor: 'user' }))).toBe('waiting')
    expect(poseOf(member('a', { activity: 'waiting', waitingFor: 'member' }))).toBe('idle')
    expect(poseOf(member('a', { activity: 'waiting', waitingFor: 'budget' }))).toBe('puzzled')
    expect(poseOf(member('a', { activity: 'starting' }))).toBe('happy')
    // idle and only needing a new instruction: drawn by how her run ended, not as blocked on you
    expect(poseOf(member('a', { waitingFor: 'user', outcome: 'completed' }))).toBe('handing')
    expect(poseOf(member('a', { waitingFor: 'user', outcome: 'aborted' }))).toBe('idle')
    expect(poseOf(member('a', { waitingFor: 'user' }))).toBe('resting')
  })
  it('never draws idle as done, and keeps failure, a finished stop and a stop in progress apart', () => {
    expect(poseOf(member('a'))).toBe('resting')
    expect(poseOf(member('a', { outcome: 'completed' }))).toBe('handing')
    expect(poseOf(member('a', { outcome: 'failed' }))).toBe('puzzled')
    expect(poseOf(member('a', { outcome: 'unknown' }))).toBe('puzzled')
    expect(poseOf(member('a', { outcome: 'aborted' }))).toBe('idle')
    expect(poseOf(member('a', { activity: 'stopping', outcome: 'none' }))).toBe('idle')
    expect(poseOf(member('a', { activity: 'stopping' }))).not.toBe('handing')
  })
})

describe('stable places', () => {
  it('keeps members where they were and fills the lowest free slot', () => {
    const first = assignSlots(new Map(), ['a', 'b', 'c'])
    expect([...first]).toEqual([['a', 0], ['b', 1], ['c', 2]])
    const second = assignSlots(first, ['c', 'a', 'd'])
    expect(second.get('a')).toBe(0); expect(second.get('c')).toBe(2); expect(second.get('d')).toBe(1)
  })
  it('leaves members beyond the visible slots off-stage until a place frees up', () => {
    const keys = Array.from({ length: TEAM_SLOTS.length + 2 }, (_, i) => `m${i}`)
    const full = assignSlots(new Map(), keys)
    expect(full.size).toBe(TEAM_SLOTS.length)
    const after = assignSlots(full, keys.slice(1))
    expect(after.get(keys[TEAM_SLOTS.length])).toBe(0)
    expect(after.size).toBe(TEAM_SLOTS.length)
  })
})

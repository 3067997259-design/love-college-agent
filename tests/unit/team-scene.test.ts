import { describe, expect, it } from 'vitest'
import { assignSlots, assignStations, depthOf, memberKey, OCCLUDERS, placeOf, poseOf, slotOf, STATIONS, teamActive, teamMembers } from '../../src/renderer/src/book/team/teamScene'
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
    expect(poseOf(member('a', { activity: 'running' }))).toBe('idle')
    expect(poseOf(member('a', { activity: 'running' }))).toBe(poseOf(member('a', { activity: 'running', revision: 9 })))
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
    const first = assignSlots(new Map(), ['a', 'b', 'c'], 4)
    expect([...first]).toEqual([['a', 0], ['b', 1], ['c', 2]])
    const second = assignSlots(first, ['c', 'a', 'd'], 4)
    expect(second.get('a')).toBe(0); expect(second.get('c')).toBe(2); expect(second.get('d')).toBe(1)
  })
  it('leaves members beyond the visible slots off-stage until a place frees up', () => {
    const keys = Array.from({ length: 6 }, (_, i) => `m${i}`)
    const full = assignSlots(new Map(), keys, 4)
    expect(full.size).toBe(4)
    const after = assignSlots(full, keys.slice(1), 4)
    expect(after.get(keys[4])).toBe(0)
    expect(after.size).toBe(4)
  })
})

const worker = (id: string, focus: 'files' | 'research' | 'team', templateId = 'dsh.edit') => member(id, { activity: 'running', work: { templateId, phase: 'tool', sinceMs: 0, focus, long: false } })
it('places helpers by sustained focus, poses by current tool and keeps short thinking at the same place', () => {
  expect(placeOf(worker('a', 'files'))).toBe('table')
  expect(placeOf(worker('a', 'research', 'dsh.search'))).toBe('bookshelf')
  expect(placeOf(worker('a', 'team', 'dsh.plan'))).toBe('desk')
  expect(poseOf(worker('a', 'files', 'dsh.shell'))).toBe('typing')
  expect(poseOf(worker('a', 'files', 'dsh.web'))).toBe('reading')
  const thinking = worker('a', 'files'); thinking.work = { ...thinking.work!, phase: 'thinking', templateId: null }
  expect(placeOf(thinking, 'table')).toBe('table'); expect(poseOf(thinking, 'typing')).toBe('typing')
  thinking.work.long = true; expect(poseOf(thinking, 'typing')).toBe('puzzled')
  expect(placeOf(member('a', { outcome: 'failed' }), 'desk')).toBe('desk')
  expect(placeOf(member('a', { activity: 'waiting', waitingFor: 'approval' }), 'table')).toBe('rug')
})
it('keeps per-station seats through reorder, then fills rug overflow and caps visible members', () => {
  const members = Array.from({ length: 8 }, (_, i) => worker(`m${i}`, 'files'))
  const first = assignStations(new Map(), members)
  expect([...first.values()].filter((place) => place.station === 'table')).toHaveLength(4)
  expect([...first.values()].filter((place) => place.station === 'rug')).toHaveLength(3)
  expect(first.size).toBe(7)
  const reorder = assignStations(first, [...members].reverse())
  for (const member of members.slice(0, 4)) expect(reorder.get(memberKey(member))).toEqual(first.get(memberKey(member)))
  const moved = assignStations(first, members.map((member, i) => i === 0 ? worker('m0', 'research') : member))
  expect(moved.get(memberKey(members[0]))?.station).toBe('bookshelf')
  expect(moved.get(memberKey(members[1]))).toEqual(first.get(memberKey(members[1])))
  expect(new Set([...moved.values()].map((place) => `${place.station}:${place.index}`)).size).toBe(moved.size)
})
it('sorts furniture over seats behind it, leaving foreground helpers above the furniture', () => {
  for (const seats of Object.values(STATIONS)) for (const slot of seats) {
    if (slot.behind) expect(depthOf(slot)).toBeLessThan(OCCLUDERS.find((layer) => layer.id === slot.behind)!.depth)
    expect(slot.x).toBeGreaterThan(0); expect(slot.y).toBeLessThan(1)
  }
  expect(depthOf(slotOf({ station: 'rug', index: 0 }))).toBeGreaterThan(Math.max(...OCCLUDERS.map((layer) => layer.depth)))
})

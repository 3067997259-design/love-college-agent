import type { AgentView, CollaborationView } from '../../../../shared/collaboration'

/** Approved sprites are placeholders until the station-specific art is reviewed. Never mirror them. */
export type TeamPose = 'idle' | 'happy' | 'typing' | 'reading' | 'carrying' | 'waiting' | 'handing' | 'puzzled' | 'resting'
export type Station = 'table' | 'bookshelf' | 'desk' | 'rug' | 'rest' | 'door'
export interface TeamSlot { x: number; y: number; h: number; facing: 'front' | 'left' | 'right' | 'back'; behind?: 'table' | 'desk' | 'chair' }
export interface Place { station: Station; index: number }
/** Feet in the approved square room image. Four seats beside the tea table, never on its top. */
export const STATIONS: Readonly<Record<Station, readonly TeamSlot[]>> = {
  table: [
    { x: .20, y: .735, h: .155, facing: 'front', behind: 'table' },
    { x: .34, y: .758, h: .155, facing: 'front', behind: 'table' },
    { x: .075, y: .83, h: .17, facing: 'right', behind: 'table' },
    { x: .475, y: .88, h: .17, facing: 'left' },
  ],
  bookshelf: [{ x: .10, y: .68, h: .14, facing: 'back' }, { x: .30, y: .66, h: .13, facing: 'left' }],
  desk: [{ x: .56, y: .79, h: .18, facing: 'right', behind: 'desk' }, { x: .895, y: .80, h: .19, facing: 'left', behind: 'chair' }],
  rug: [{ x: .66, y: .945, h: .18, facing: 'front' }, { x: .83, y: .95, h: .18, facing: 'front' }, { x: .52, y: .98, h: .18, facing: 'front' }],
  rest: [{ x: .20, y: .96, h: .19, facing: 'front' }, { x: .38, y: .98, h: .19, facing: 'front' }],
  door: [{ x: .055, y: .94, h: .20, facing: 'right' }],
}
/** Copies of the same room, clipped to furniture silhouettes: no generated or replaced asset. */
export const OCCLUDERS = [
  { id: 'desk', depth: .805, polygon: '37.1% 51.7%, 54.5% 46.7%, 70.7% 51.5%, 61.9% 55.7%, 61.9% 79.5%, 60.4% 80.1%, 58.8% 79.5%, 58.8% 55.7%, 40.4% 53.7%, 40.4% 70.8%, 37.5% 70.7%, 37.5% 53.7%, 37.1% 53.5%' },
  { id: 'chair', depth: .81, polygon: '85.1% 44.1%, 90.9% 42.1%, 91.5% 42.9%, 90.8% 46.3%, 89.4% 58.6%, 89.4% 60.5%, 88.4% 61.5%, 90.4% 72.3%, 89.5% 72.7%, 86.5% 62.5%, 84.8% 62.8%, 86.8% 76.8%, 85.4% 77.2%, 82.7% 63.1%, 74.3% 61.6%, 72.4% 74.5%, 70.8% 74.3%, 72.1% 61.3%, 71.6% 60.9%, 71.8% 59.4%, 83.5% 60.7%' },
  { id: 'table', depth: .87, polygon: '6.4% 73.3%, 19.6% 67.9%, 45.1% 72.3%, 45.2% 74.7%, 44.3% 75.4%, 44.3% 85.9%, 43.3% 86.5%, 41.4% 85.9%, 41.4% 76.8%, 32.8% 81.1%, 32.8% 93.9%, 31.3% 94.7%, 29.7% 94%, 29.7% 81.1%, 23% 79.3%, 23% 80.4%, 21.7% 80.9%, 20.5% 80.4%, 20.5% 78.6%, 10.1% 75.8%, 10.1% 86.6%, 8.7% 87.3%, 7.2% 86.8%, 7.2% 75.4%, 6.4% 75%' },
] as const
export const slotOf = (place: Place) => STATIONS[place.station][place.index]
export const depthOf = (slot: TeamSlot) => slot.behind ? Math.min(slot.y, OCCLUDERS.find((item) => item.id === slot.behind)!.depth - .001) : slot.y
export const memberKey = (member: AgentView) => `${member.address.runtimeId}:${member.address.sessionId}`
export const teamActive = (members: readonly AgentView[]) => members.some((member) => ['starting', 'running', 'waiting', 'stopping'].includes(member.activity))
export function teamMembers(view: CollaborationView | null | undefined): AgentView[] {
  return view?.status === 'ready' ? view.members.filter((member) => member.mode !== 'root' && member.activity !== 'unavailable') : []
}
export const memberFailed = (member: AgentView) => !!member.error || ['failed', 'refused', 'unknown'].includes(member.outcome)
const areaPlace = (member: AgentView, previous?: Station): Station => member.work?.focus === 'files' ? 'table' : member.work?.focus === 'research' ? 'bookshelf'
  : member.work?.focus === 'team' ? 'desk' : previous ?? 'door'
export function placeOf(member: AgentView, previous?: Station): Station {
  if (member.activity === 'starting') return 'door'
  if (memberFailed(member)) return previous ?? 'rug'
  if (member.activity === 'inactive') return 'rest'
  if (member.waitingFor === 'approval' || member.waitingFor === 'user') return 'rug'
  if (member.activity === 'stopping') return previous ?? areaPlace(member)
  return areaPlace(member, previous)
}
export function poseOf(member: AgentView, previous: TeamPose = 'idle'): TeamPose {
  if (memberFailed(member)) return 'puzzled' // a shape badge distinguishes errors until the new pose is approved
  if (member.activity === 'inactive') return member.outcome === 'completed' ? 'handing' : member.outcome === 'aborted' ? 'idle' : 'resting'
  if (member.waitingFor === 'approval' || member.waitingFor === 'user') return 'waiting'
  if (member.waitingFor === 'budget' || member.waitingFor === 'recovery') return 'puzzled'
  if (member.waitingFor === 'member' || member.activity === 'stopping') return 'idle'
  if (member.activity === 'starting') return 'happy'
  if (member.work?.phase === 'thinking') return member.work.long ? 'puzzled' : previous
  if (member.work?.phase === 'note') return 'carrying'
  const template = member.work?.templateId
  if (['dsh.read', 'dsh.write', 'dsh.edit', 'dsh.shell'].includes(template ?? '')) return 'typing'
  if (['dsh.search', 'dsh.web', 'dsh.skill'].includes(template ?? '')) return 'reading'
  if (['dsh.agent', 'dsh.plan'].includes(template ?? '')) return 'carrying'
  return 'idle'
}
/** Keep existing seats within each station; fill holes without reshuffling other members. */
export function assignSlots(previous: ReadonlyMap<string, number>, keys: readonly string[], slotCount: number): Map<string, number> {
  const next = new Map<string, number>(), used = new Set<number>()
  for (const key of keys) { const slot = previous.get(key); if (slot !== undefined && slot >= 0 && slot < slotCount && !used.has(slot)) { next.set(key, slot); used.add(slot) } }
  for (const key of keys) {
    if (next.has(key)) continue
    let slot = 0; while (used.has(slot)) slot++
    if (slot < slotCount) { next.set(key, slot); used.add(slot) }
  }
  return next
}
export function assignStations(previous: ReadonlyMap<string, Place>, members: readonly AgentView[]): Map<string, Place> {
  const next = new Map<string, Place>(), wanted = new Map(members.map((member) => [memberKey(member), placeOf(member, previous.get(memberKey(member))?.station)]))
  for (const station of Object.keys(STATIONS) as Station[]) {
    const keys = [...wanted].filter(([, value]) => value === station).map(([key]) => key)
    const old = new Map([...previous].filter(([, value]) => value.station === station).map(([key, value]) => [key, value.index]))
    for (const [key, index] of assignSlots(old, keys, STATIONS[station].length)) next.set(key, { station, index })
  }
  const used = new Set([...next.values()].filter((place) => place.station === 'rug').map((place) => place.index))
  for (const member of members) {
    const key = memberKey(member)
    if (next.has(key)) continue
    const old = previous.get(key), index = old?.station === 'rug' && !used.has(old.index) ? old.index : STATIONS.rug.findIndex((_, i) => !used.has(i))
    if (index >= 0) { used.add(index); next.set(key, { station: 'rug', index }) }
  }
  return next
}

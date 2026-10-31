import type { AgentView, CollaborationView } from '../../../../shared/collaboration'

/** Identity and ribbon side are baked into directional art; never mirror sprites. */
export type TeamPose = 'idle' | 'entering' | 'typing' | 'reading' | 'carrying' | 'waiting' | 'completed' | 'thinking' | 'resting' | 'failed' | 'stopping' | 'blocked'
export type Station = 'table' | 'bookshelf' | 'desk' | 'rug' | 'rest' | 'door'
/**
 * A tea-table place: she types standing on a stool (drawn in her picture) at a laptop prop on the tabletop.
 * `laptop` is the laptop's foot on the floor plan; it is drawn on the tabletop straight above it. Props may be mirrored.
 * `stool: 'hidden'` where the tabletop covers the stool from this camera, so other poses stand on it unseen.
 * `over` redraws her from the hands up above the table: she stands behind it, but her hands rest on the laptop.
 */
export interface TableSeat {
  sprite: 'stool-back-right' | 'stool-end-left' | 'stool-end-right'
  laptop: { prop: 'laptop-back' | 'laptop-side'; x: number; y: number; mirror?: boolean }
  stool: 'hidden' | 'visible'
  over?: boolean
}
/** A place in the approved square room image: her feet at (x, y) as fractions of the room. `behind` names the furniture drawn over her. */
export interface TeamSlot { x: number; y: number; facing: 'front' | 'left' | 'right' | 'back'; behind?: 'table' | 'desk' | 'chair'; seat?: TableSeat }
export interface Place { station: Station; index: number }
/**
 * One size rule for every helper and every pose: her head height depends only on how low her feet are in the picture.
 * The room art draws its furniture with weak perspective (the tea table's four legs and the chair put the horizon near
 * y = .06), so a helper at the back is only about a third smaller than one at the front. A front-row head is 50 px of a
 * 600 px room: small enough for nine helpers, and the farthest place still keeps a standing helper about 84 px tall.
 * Sizing by the whole picture instead let seated and reaching poses grow by half or more.
 */
export const DEPTH = { horizon: .06, frontY: .96, frontHead: 50 / 600 } as const
export const headAt = (y: number) => DEPTH.frontHead * (y - DEPTH.horizon) / (DEPTH.frontY - DEPTH.horizon)
/** The tea table's legs measure 1.85 heads at every depth (same horizon as the size rule), so its top is this high. */
export const TABLE_HEADS = 1.85
export const tabletopAt = (y: number) => y - TABLE_HEADS * headAt(y)
/** Her stool is about 1.05 heads tall: standing on it, her hands (held at her waist) reach the tabletop. */
export const STOOL_HEADS = 1.05
/**
 * Places follow the room's free floor (measured on the 2048 px room image). The tea table nearly touches the bookshelf,
 * so research happens in the strip of floor between them; helpers who need you come forward onto the sunlit floor.
 */
export const STATIONS: Readonly<Record<Station, readonly TeamSlot[]>> = {
  // One place behind the far side of the tea table and one at each short end; the left half of the far side stays clear
  // so the helpers at the bookshelf behind it are not hidden.
  table: [
    { x: .355, y: .826, facing: 'left', behind: 'table', seat: { sprite: 'stool-back-right', laptop: { prop: 'laptop-back', x: .33, y: .85 }, stool: 'hidden' } },
    { x: .462, y: .871, facing: 'left', seat: { sprite: 'stool-end-right', laptop: { prop: 'laptop-side', x: .415, y: .868, mirror: true }, stool: 'visible' } },
    { x: .107, y: .841, facing: 'right', behind: 'table', seat: { sprite: 'stool-end-left', laptop: { prop: 'laptop-side', x: .16, y: .855 }, stool: 'hidden', over: true } },
  ],
  bookshelf: [{ x: .20, y: .685, facing: 'left' }, { x: .275, y: .668, facing: 'back' }],
  // Beside her: by the desk's near leg, and in front of her chair.
  desk: [{ x: .655, y: .815, facing: 'right' }, { x: .80, y: .82, facing: 'left' }],
  rug: [{ x: .58, y: .945, facing: 'front' }, { x: .73, y: .95, facing: 'front' }, { x: .88, y: .945, facing: 'front' }],
  // In front of the tea table, clear of the helper at its left end.
  rest: [{ x: .175, y: .955, facing: 'front' }, { x: .30, y: .96, facing: 'front' }],
  // There is no door in the art: newcomers walk in from the front edge.
  door: [{ x: .43, y: .962, facing: 'right' }],
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
  if (memberFailed(member)) return 'failed'
  if (member.activity === 'inactive') return member.outcome === 'completed' ? 'completed' : member.outcome === 'aborted' ? 'idle' : 'resting'
  if (member.activity === 'stopping') return 'stopping'
  if (member.waitingFor === 'approval' || member.waitingFor === 'user') return 'waiting'
  if (member.waitingFor === 'budget' || member.waitingFor === 'recovery') return 'blocked'
  if (member.waitingFor === 'member') return 'idle'
  if (member.activity === 'starting') return 'entering'
  // A new turn must never inherit the previous turn's completed/failed/waiting gesture.
  if (member.work?.phase === 'thinking') return !member.work.long && ['typing', 'reading', 'carrying'].includes(previous) ? previous : 'thinking'
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

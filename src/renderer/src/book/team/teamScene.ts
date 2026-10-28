import type { AgentView, CollaborationView } from '../../../../shared/collaboration'

/** Mini 桃子 sprites in assets/character/taozi/team (manifest.json says where each came from). */
export type TeamPose = 'idle' | 'happy' | 'typing' | 'reading' | 'carrying' | 'waiting' | 'handing' | 'puzzled' | 'resting'

/**
 * Where a helper can stand in the team room: feet position as a fraction of the square room image, and her height as a
 * fraction of the room's height. The low table and rug in front were left empty for them; nobody stands behind furniture,
 * because the furniture is part of the background and cannot cover a sprite. Filled in this order.
 */
export interface TeamSlot { x: number; y: number; h: number }
export const TEAM_SLOTS: readonly TeamSlot[] = [
  { x: 0.19, y: 0.775, h: 0.15 }, // on the low table, left
  { x: 0.53, y: 0.87, h: 0.19 }, // rug, between the low table and the desk
  { x: 0.35, y: 0.775, h: 0.15 }, // on the low table, right
  { x: 0.82, y: 0.92, h: 0.21 }, // floor, front right
  { x: 0.665, y: 0.86, h: 0.18 }, // floor by the desk
  { x: 0.41, y: 0.965, h: 0.21 }, // rug, front
]

const ACTIVE = new Set<AgentView['activity']>(['starting', 'running', 'waiting', 'stopping'])
const WORK: readonly TeamPose[] = ['typing', 'reading', 'carrying']

export const memberKey = (member: AgentView) => `${member.address.runtimeId}:${member.address.sessionId}`

/** Her helpers: everyone in the family but her, unless DSH can no longer reach them. */
export function teamMembers(view: CollaborationView | null | undefined): AgentView[] {
  if (!view || view.status !== 'ready') return []
  return view.members.filter((member) => member.mode !== 'root' && member.activity !== 'unavailable')
}

/** Someone is starting, working, waiting on something or being stopped: the room is where the action is. */
export const teamActive = (members: readonly AgentView[]) => members.some((member) => ACTIVE.has(member.activity))

/** A small stable number from a member's identity, so a worker keeps the same activity between events. */
function stableIndex(key: string, size: number): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return hash % size
}

/**
 * The pose comes from facts only. `variant` picks which kind of work a running helper is drawn doing; the room passes
 * her place, so neighbours differ and nobody changes activity between events.
 * Running is work; waiting shows what she waits for; inactive only means there is no
 * turn now, so it is drawn as "done" only when the last outcome says completed. Failure and a requested stop look
 * different, and a stop that is still in progress is not drawn as stopped. An idle helper who only needs a new instruction
 * (DSH says she waits for the user because nobody authorized more work) is drawn by how her last run ended.
 */
export function poseOf(member: AgentView, variant = stableIndex(memberKey(member), WORK.length)): TeamPose {
  const needsNewWord = member.activity === 'inactive' && member.waitingFor === 'user'
  if (!needsNewWord && (member.activity === 'waiting' || member.waitingFor)) {
    if (member.waitingFor === 'approval' || member.waitingFor === 'user') return 'waiting'
    if (member.waitingFor === 'budget' || member.waitingFor === 'recovery') return 'puzzled'
    return 'idle'
  }
  if (member.activity === 'starting') return 'happy'
  if (member.activity === 'running') return WORK[variant % WORK.length]
  if (member.activity === 'stopping') return 'idle'
  if (member.outcome === 'completed') return 'handing'
  if (member.outcome === 'failed' || member.outcome === 'refused' || member.outcome === 'unknown' || member.error) return 'puzzled'
  if (member.outcome === 'aborted') return 'idle'
  return 'resting'
}

/**
 * Keep everyone where they were: existing members keep their slot, new ones take the lowest free slot, and those
 * who left free theirs. Members beyond the visible slots wait off-stage until one frees up.
 */
export function assignSlots(previous: ReadonlyMap<string, number>, keys: readonly string[], slotCount = TEAM_SLOTS.length): Map<string, number> {
  const next = new Map<string, number>()
  for (const key of keys) { const slot = previous.get(key); if (slot !== undefined && slot < slotCount) next.set(key, slot) }
  const used = new Set(next.values())
  for (const key of keys) {
    if (next.has(key)) continue
    let slot = 0
    while (slot < slotCount && used.has(slot)) slot++
    if (slot === slotCount) continue
    next.set(key, slot); used.add(slot)
  }
  return next
}

import type { AgentView } from '../../../../shared/collaboration'
import metrics from '../../assets/character/taozi/team/sprite-metrics.json'
import { headAt, STOOL_HEADS, type Place, type TeamPose, type TeamSlot } from './teamScene'

export interface SpriteMetrics {
  file: string; sha256: string; width: number; height: number
  head: { top: number; height: number; left: number; width: number }; footX: number; bottom: number
}
/** Measured by art/tools/measure-team-sprites.mjs: the head box sizes every pose alike, the foot centre anchors her. */
export const SPRITES: Readonly<Record<string, SpriteMetrics>> = metrics.sprites
/** Sprites the room cannot do without; a character package lacking any of them keeps the close view. */
export const TEAM_SPRITES = ['shelf-reach', 'reading-back', 'note-right', 'note-left', 'entering', 'idle', 'thinking', 'waiting', 'failed', 'completed', 'resting', 'stopping']

/**
 * Which picture shows this pose at this place. Sprites are never mirrored, so direction comes from the place's facing.
 * Typing at the tea table means standing on a stool at the laptop. Until that art exists, a helper reading her notes
 * stands in. Where the tabletop hides the stool she is lifted onto it; at the table ends she stands on the floor.
 */
export function artOf(pose: TeamPose, place: Place, slot: TeamSlot): { sprite: string; lift: number } {
  const note = slot.facing === 'left' || (slot.facing === 'front' && place.index % 2 === 1) ? 'note-left' : 'note-right'
  const sprite = pose === 'typing' || pose === 'carrying' ? note
    : pose === 'reading' ? slot.facing === 'left' ? 'shelf-reach' : 'reading-back'
    : pose === 'blocked' ? 'stopping' : pose
  return { sprite, lift: slot.stool === 'hidden' ? STOOL_HEADS : 0 }
}

/**
 * Where her picture goes, in room fractions: head height from the depth rule, picture height from her head box, feet
 * on the place (raised by a stool when the picture has none). CSS anchors the picture at its foot centre.
 */
export function figureOf(slot: TeamSlot, art: { sprite: string; lift: number }) {
  const m = SPRITES[art.sprite], head = headAt(slot.y), height = head * m.height / m.head.height
  return {
    x: slot.x, feet: slot.y - art.lift * head, height, head,
    footX: m.footX / m.width, footPad: (m.height - 1 - m.bottom) / m.height,
    hit: { left: m.head.left / m.width, top: m.head.top / m.height, width: m.head.width / m.width, height: m.head.height / m.height },
  }
}

export function badgeOf(member: AgentView): string | undefined {
  if (member.error) return '出错了'
  if (member.outcome === 'unknown') return '待核对'
  if (member.outcome === 'refused') return '未批准'
  if (member.outcome === 'failed') return '未完成'
  if (member.activity === 'inactive') return member.outcome === 'completed' ? '已完成' : member.outcome === 'aborted' ? '已停下' : undefined
  if (member.activity === 'stopping') return '正在停下'
  return member.waitingFor ? { approval: '等批准', user: '等你回答', budget: '额度不足', recovery: '等待恢复', member: '等同伴' }[member.waitingFor] : undefined
}

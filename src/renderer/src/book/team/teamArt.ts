import type { AgentView } from '../../../../shared/collaboration'
import metrics from '../../assets/character/taozi/team/sprite-metrics.json'
import { headAt, OCCLUDERS, STOOL_HEADS, tabletopAt, type Place, type TableSeat, type TeamPose, type TeamSlot } from './teamScene'

export interface SpriteMetrics {
  file: string; sha256: string; width: number; height: number
  head: { top: number; height: number; left: number; width: number }; footX: number; bottom: number; hands?: number
}
export interface PropMetrics { file: string; sha256: string; width: number; height: number; bottom: number; headPx: number }
/** Measured by art/tools/measure-team-sprites.mjs: the head box sizes every pose alike, the foot centre anchors her. */
export const SPRITES: Readonly<Record<string, SpriteMetrics>> = metrics.sprites
export const PROPS: Readonly<Record<string, PropMetrics>> = metrics.props
/** Sprites the room cannot do without; a character package lacking any of them keeps the close view. */
export const TEAM_SPRITES = ['shelf-reach', 'reading-back', 'note-right', 'note-left', 'entering', 'idle', 'thinking', 'waiting', 'failed', 'completed', 'resting', 'stopping',
  'stool-back-right', 'stool-end-left', 'stool-end-right']
export const TEAM_PROPS = ['laptop-back', 'laptop-side']
const TABLE_DEPTH = OCCLUDERS.find((item) => item.id === 'table')!.depth

/**
 * Which picture shows this pose at this place. Sprites are never mirrored, so direction comes from the place's facing.
 * Working at the tea table (typing, or looking things up on the laptop) is the stool picture for that seat. Other poses
 * there stand on the same stool where the tabletop hides it; at the table ends she has stepped down beside it.
 */
export function artOf(pose: TeamPose, place: Place, slot: TeamSlot): { sprite: string; lift: number } {
  if (slot.seat && (pose === 'typing' || pose === 'reading')) return { sprite: slot.seat.sprite, lift: 0 }
  const note = slot.facing === 'left' || (slot.facing === 'front' && place.index % 2 === 1) ? 'note-left' : 'note-right'
  const sprite = pose === 'typing' || pose === 'carrying' ? note
    : pose === 'reading' ? slot.facing === 'left' ? 'shelf-reach' : 'reading-back'
    : pose === 'blocked' ? 'stopping' : pose
  return { sprite, lift: slot.seat?.stool === 'hidden' ? STOOL_HEADS : 0 }
}

/**
 * Where her picture goes, in room fractions: head height from the depth rule, picture height from her head box, feet
 * on the place (raised by a stool when the picture has none). CSS anchors the picture at its foot centre.
 * Lifted onto a stool the tabletop hides, her shoes could show in the gap under the table: `cut` trims them off.
 * `over` is the part of the picture (from the top) drawn again above the table, down to just below her hands.
 */
export function figureOf(slot: TeamSlot, art: { sprite: string; lift: number }) {
  const m = SPRITES[art.sprite], head = headAt(slot.y), height = head * m.height / m.head.height
  const over = slot.seat?.over && art.sprite === slot.seat.sprite && m.hands !== undefined ? Math.min(1, (m.hands + m.head.height * .06) / m.height) : undefined
  return {
    x: slot.x, feet: slot.y - art.lift * head, height, head, over, cut: art.lift ? (m.height - 1 - m.bottom + .3 * m.head.height) / m.height : 0,
    footX: m.footX / m.width, footPad: (m.height - 1 - m.bottom) / m.height,
    hit: { left: m.head.left / m.width, top: m.head.top / m.height, width: m.head.width / m.width, height: m.head.height / m.height },
  }
}

/**
 * The laptop at a tea-table seat, in room fractions: its bottom centre sits on the tabletop above its floor point, sized
 * by the depth rule like her. Drawn just above the table; a helper standing in front of the table still covers it.
 */
export function laptopOf(seat: TableSeat) {
  const { prop, x, y, mirror = false } = seat.laptop, m = PROPS[prop]
  return { prop, x, feet: tabletopAt(y), height: headAt(y) * m.height / m.headPx, footPad: (m.height - 1 - m.bottom) / m.height, mirror, depth: TABLE_DEPTH + .0002 }
}
/** Her redrawn upper half sits above the laptops, so her hands rest on the keyboard. */
export const OVER_DEPTH = TABLE_DEPTH + .0004

export function badgeOf(member: AgentView): string | undefined {
  if (member.error) return '出错了'
  if (member.outcome === 'unknown') return '结果不明'
  if (member.outcome === 'refused') return '未批准'
  if (member.outcome === 'failed') return '未完成'
  if (member.activity === 'inactive') return member.outcome === 'completed' ? '已完成' : member.outcome === 'aborted' ? '已停下' : undefined
  if (member.activity === 'stopping') return '正在停下'
  return member.waitingFor ? { approval: '等批准', user: '等你回答', budget: '额度不足', recovery: '等待恢复', member: '等同伴' }[member.waitingFor] : undefined
}

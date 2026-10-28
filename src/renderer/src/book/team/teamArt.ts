import type { AgentView } from '../../../../shared/collaboration'
import type { Place, TeamPose } from './teamScene'

const table = ['table-far-left', 'table-far-right', 'table-left', 'table-right'] as const
// Only the arms and laptop are copied back above the table. The skirt and stool stay behind it.
const tabletop = [
  'polygon(0% 0%,100% 0%,100% 64%,90% 64%,63.5% 69.7%,41% 65%,0% 65%)',
  'polygon(0% 0%,100% 0%,100% 66%,60% 66%,40% 70.1%,12% 66%,0% 65%)',
  'inset(0 0 35% 0)',
]
export const TEAM_SPRITES = [...table, 'shelf-reach', 'reading-back', 'note-right', 'note-left', 'entering', 'idle', 'thinking', 'waiting', 'failed', 'completed', 'resting', 'stopping']
export function artOf(pose: TeamPose, place: Place) {
  if (pose === 'typing' && place.station === 'table') return { sprite: table[place.index], foreground: tabletop[place.index] }
  const sprite = pose === 'typing' ? 'note-left' // overflow has no desk; do not suspend a seated sprite in the air
    : pose === 'reading' ? place.station === 'bookshelf' && place.index === 0 ? 'shelf-reach' : 'reading-back'
    : pose === 'carrying' ? place.station === 'desk' && place.index === 0 ? 'note-right' : 'note-left'
    : pose === 'blocked' ? 'stopping' : pose
  return { sprite, foreground: undefined }
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

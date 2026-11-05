import type { AppBridge, AppSnapshot } from '../../../../shared'
import type { AgentView } from '../../../../shared/collaboration'
import { activityKind } from '../../voice/activity-text'
import { memberText, memberWorkText } from '../CollaborationPanel'
import { memberFailed, memberKey } from './teamScene'
import { durationText, useMemberElapsed, useMemberSteps } from './useMemberProgress'
import './subagent-strip.css'

// The room is one picture; each strip panel shows a slice of it as its own little backdrop.
// Table sprites are excluded: their stool is always cropped out by the panel, so they would only add weight.
const files = import.meta.glob([
  '../../assets/character/taozi/team/room-day.webp',
  '../../assets/character/taozi/team/mini-v2-*.png',
  '!../../assets/character/taozi/team/mini-v2-table-*.png',
], { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const roomSrc = files['../../assets/character/taozi/team/room-day.webp']
const poseSrc = (sprite: string) => files[`../../assets/character/taozi/team/mini-v2-${sprite}.png`]

/** One kind of job. Helpers doing the same job share a panel instead of crowding the page. */
type Station = 'waiting' | 'failed' | 'blocked' | 'starting' | 'files' | 'research' | 'team' | 'thinking' | 'other'
type Scene = 'desk' | 'shelf' | 'rug' | 'rug-dim' | 'window' | 'window-edge'

/** Lower number wins the three visible slots. */
const PRIORITY: Record<Station, number> = { waiting: 0, failed: 1, blocked: 2, starting: 3, files: 4, research: 4, team: 4, thinking: 5, other: 6 }
/** Which panel backdrop and which pose belong to that job. The backdrop keeps the line weight close to hers. */
const LOOK: Record<Station, { sprite: string; scene: Scene }> = {
  waiting: { sprite: 'waiting', scene: 'rug' },
  failed: { sprite: 'failed', scene: 'rug-dim' },
  blocked: { sprite: 'stopping', scene: 'rug-dim' },
  starting: { sprite: 'entering', scene: 'window-edge' },
  files: { sprite: 'stool-end-right', scene: 'desk' },
  research: { sprite: 'shelf-reach', scene: 'shelf' },
  team: { sprite: 'note-right', scene: 'window-edge' },
  thinking: { sprite: 'thinking', scene: 'window' },
  other: { sprite: 'note-left', scene: 'window-edge' },
}
const TONE: Record<Station, string> = {
  waiting: 'wait', failed: 'fail', blocked: 'blocked', starting: 'run', files: 'run', research: 'run', team: 'run', thinking: 'run', other: 'run',
}
/** Three panels at most: beyond that the page stops reading as a book page. */
const MAX_PANELS = 3
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '…' : text)

/**
 * What a helper is doing, as one job kind. `null` means she is not on stage: finished, idle, or unobservable.
 * A live error always stays on stage; a failure that already ended joins the pile at the bottom.
 */
function stationOf(member: AgentView): Station | null {
  if (member.activity === 'unavailable') return null
  const waiting = member.waitingFor
  if (waiting === 'approval' || waiting === 'user') return 'waiting'
  if (member.error) return 'failed'
  if (member.activity === 'inactive') return null
  if (memberFailed(member)) return 'failed'
  if (waiting === 'budget' || waiting === 'recovery' || member.activity === 'stopping') return 'blocked'
  if (member.activity === 'starting') return 'starting'
  if (member.work?.phase === 'thinking') return 'thinking'
  const focus = member.work?.focus
  if (focus === 'files') return 'files'
  if (focus === 'research') return 'research'
  if (focus === 'team') return 'team'
  return 'other'
}

type Panel = { station: Station; members: readonly AgentView[]; lead: AgentView }

/** Newest activation leads the panel: that is the one whose step is worth reading. */
const newest = (members: readonly AgentView[]): AgentView =>
  members.reduce((best, member) => ((member.work?.sinceMs ?? 0) > (best.work?.sinceMs ?? 0) ? member : best), members[0]!)

function groupPanels(members: readonly AgentView[]) {
  const grouped = new Map<Station, AgentView[]>()
  for (const member of members) {
    const station = stationOf(member)
    if (!station) continue
    const list = grouped.get(station)
    if (list) list.push(member)
    else grouped.set(station, [member])
  }
  const ordered = [...grouped.entries()].sort((a, b) => PRIORITY[a[0]] - PRIORITY[b[0]])
  const panels: Panel[] = ordered.slice(0, MAX_PANELS).map(([station, list]) => ({ station, members: list, lead: newest(list) }))
  const onStage = new Set(panels.flatMap((panel) => panel.members))
  return { panels, offstage: members.filter((member) => !onStage.has(member)) }
}

/**
 * Left page, bottom: one hand-drawn panel per job kind, at most three. The page never pulls back to the whole
 * room on its own any more — her close view, and the side-lit thinking face that belongs to it, stay where they are.
 * Everything a panel cannot hold goes into the small pile button, which opens the collaboration sheet.
 */
export function SubagentStrip({ snapshot, bridge, members, onMore }: {
  snapshot: AppSnapshot; bridge: AppBridge; members: readonly AgentView[]; onMore: () => void
}) {
  if (!members.length) return null
  const { panels, offstage } = groupPanels(members)
  const finished = offstage.filter((member) => member.activity === 'inactive' && member.outcome === 'completed').length
  const idle = offstage.filter((member) => member.activity === 'inactive' && member.outcome !== 'completed').length
  const busy = offstage.filter((member) => member.activity !== 'inactive' && member.activity !== 'unavailable').length
  const pile = [finished ? `已完成 ${finished}` : '', idle ? `空闲 ${idle}` : '', busy ? `另有 ${busy} 位在忙` : ''].filter(Boolean).join(' · ')
  const more = (): void => { onMore() }
  return <div className="subagent-strip" role="group" aria-label="帮手">
    {panels.map((panel) => <SubagentPanel key={`${snapshot.epoch}:${panel.station}:${memberKey(panel.lead)}`}
      snapshot={snapshot} bridge={bridge} panel={panel} onMore={more} />)}
    {pile && <button type="button" className="subagent-pile" onClick={more} aria-label={`${pile}，打开协作面板`}>{pile}</button>}
  </div>
}

/** One panel: a slice of the room as its backdrop, her posing in it, and the few words worth reading. */
function SubagentPanel({ snapshot, bridge, panel, onMore }: {
  snapshot: AppSnapshot; bridge: AppBridge; panel: Panel; onMore: () => void
}) {
  const member = panel.lead
  const look = LOOK[panel.station]
  const src = poseSrc(look.sprite)
  const elapsed = useMemberElapsed(snapshot, member)
  const details = useMemberSteps(bridge, member, snapshot.epoch)
  const last = details.value?.steps.at(-1)
  const status = memberText.status(member)
  const step = (last ? last.target ?? activityKind({ templateId: last.templateId }) : null) ?? memberWorkText(member)
  const stacked = panel.members.length > 1
  const label = [member.name, status, step, stacked ? `共 ${panel.members.length} 位` : ''].filter(Boolean).join('，')
  return <button type="button" className="subagent-panel" data-station={panel.station} data-tone={TONE[panel.station]}
    data-stacked={stacked || undefined} aria-haspopup="dialog" aria-label={label} onClick={onMore} title={label}>
    <span className="subagent-shot" data-scene={look.scene} style={roomSrc ? { backgroundImage: `url("${roomSrc}")` } : undefined}>
      {src && <img className="subagent-pose" data-pose={look.sprite} src={src} alt="" draggable={false} />}
      {stacked && <span className="subagent-stack-badge" aria-hidden>×{panel.members.length}</span>}
    </span>
    <span className="subagent-lines">
      <strong className="subagent-name">{clip(member.name, 7)}</strong>
      <span className="subagent-status">{status}</span>
      <span className="subagent-step">{step ?? '——'}</span>
      {elapsed > 0 && <span className="subagent-time">{durationText(elapsed)}</span>}
    </span>
  </button>
}

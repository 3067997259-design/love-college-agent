import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../../shared'
import type { AgentView } from '../../../../shared/collaboration'
import { sendCommand } from '../command'
import { memberTarget, memberText } from '../CollaborationPanel'
import { assignSlots, memberKey, poseOf, TEAM_SLOTS, type TeamPose, type TeamSlot } from './teamScene'
import './team.css'

const files = import.meta.glob('../../assets/character/taozi/team/*.{png,webp}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const roomSrc = files['../../assets/character/taozi/team/room-day.webp']
const spriteSrc = (pose: TeamPose) => files[`../../assets/character/taozi/team/mini-${pose}.png`]
/** The built-in character has team art; a custom character package without it keeps the close view. */
export const teamArtReady = !!roomSrc
const pct = (value: number) => `${(value * 100).toFixed(2)}%`

/**
 * The team view on the left page: the whole room, her at the desk, one mini 桃子 per helper. Places are stable, the pose
 * follows the member's facts (teamScene.ts), and clicking a helper opens a small card with what is known about her.
 * The room sits inside `.room`, so the daypart tint and the lamp light it like the close view.
 */
export function TeamRoom({ snapshot, bridge, members, visible, onMore }: {
  snapshot: AppSnapshot; bridge: AppBridge; members: readonly AgentView[]; visible: boolean; onMore(): void
}) {
  const keys = members.map(memberKey)
  const slotsRef = useRef<ReadonlyMap<string, number>>(new Map())
  // Recompute places only when the set of helpers changes, never on each status event.
  const joined = keys.join('|')
  const slots = useMemo(() => assignSlots(slotsRef.current, joined ? joined.split('|') : []), [joined])
  slotsRef.current = slots
  const placed = members.flatMap((member) => {
    const slot = slots.get(memberKey(member))
    return slot === undefined ? [] : [{ member, slot: TEAM_SLOTS[slot], pose: poseOf(member, slot) }]
  }).sort((a, b) => a.slot.y - b.slot.y) // nearer helpers are drawn over farther ones
  const offstage = members.length - placed.length
  const [openKey, setOpenKey] = useState<string | null>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const open = placed.find((entry) => memberKey(entry.member) === openKey)
  useEffect(() => { if (!visible) setOpenKey(null) }, [visible])
  const close = () => { const key = openKey; setOpenKey(null); if (key) buttons.current.get(key)?.focus() }

  return (
    <div className="team-room" data-visible={visible} aria-hidden={visible ? undefined : true} aria-label={visible ? '房间里的帮手' : undefined} role={visible ? 'group' : undefined}>
      <img className="team-room-art" src={roomSrc} alt="" draggable={false} />
      {placed.map(({ member, slot, pose }) => {
        const key = memberKey(member)
        return (
          <button key={key} ref={(node) => { if (node) buttons.current.set(key, node); else buttons.current.delete(key) }}
            type="button" className="team-mini" data-pose={pose} data-busy={member.activity === 'running' || undefined}
            style={{ left: pct(slot.x), top: pct(slot.y), height: pct(slot.h) }} tabIndex={visible ? 0 : -1}
            aria-label={`${member.name}：${memberText.status(member)}`} aria-haspopup="dialog" aria-expanded={openKey === key}
            onClick={() => setOpenKey(openKey === key ? null : key)}>
            <span className="team-mini-shadow" aria-hidden />
            <img src={spriteSrc(pose)} alt="" draggable={false} />
          </button>
        )
      })}
      {offstage > 0 && <button type="button" className="team-offstage" tabIndex={visible ? 0 : -1} onClick={onMore}>还有 {offstage} 位帮手</button>}
      {open && <MemberCard key={memberKey(open.member)} member={open.member} slot={open.slot} snapshot={snapshot} bridge={bridge} onClose={close} onMore={() => { setOpenKey(null); onMore() }} />}
    </div>
  )
}

/** What is known about one helper, and the one direct action: stop her current work. Everything else lives in the panel. */
function MemberCard({ member, slot, snapshot, bridge, onClose, onMore }: {
  member: AgentView; slot: TeamSlot; snapshot: AppSnapshot; bridge: AppBridge; onClose(): void; onMore(): void
}) {
  const ref = useRef<HTMLElement>(null)
  const [sent, setSent] = useState<'accepted' | 'failed' | null>(null)
  const closeRef = useRef(onClose); closeRef.current = onClose
  useEffect(() => {
    ref.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); closeRef.current() } }
    const onDown = (event: PointerEvent) => { const target = event.target as Element | null; if (!ref.current?.contains(target) && !target?.closest?.('.team-mini')) closeRef.current() }
    window.addEventListener('keydown', onKey, true); document.addEventListener('pointerdown', onDown)
    return () => { window.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown) }
  }, [])
  const view = snapshot.collaboration
  const disabled = view?.operation?.phase === 'running' || view?.operation?.outcome === 'unknown' || snapshot.companion.lightsOut || snapshot.companion.sleeping
  const interrupt = async () => {
    const result = await sendCommand(bridge, snapshot.epoch, { type: 'agent.interrupt', target: memberTarget(member) })
    setSent(result.ok ? 'accepted' : 'failed')
  }
  const side = slot.x < 0.3 ? 'left' : slot.x > 0.7 ? 'right' : 'center'
  const status = memberText.status(member)
  const ended = member.outcome === 'none' ? null : memberText.outcome[member.outcome]
  return (
    <section ref={ref} className="team-card" role="dialog" aria-label={member.name} tabIndex={-1} data-side={side} data-photo-omit
      style={{ left: pct(slot.x), top: pct(slot.y - slot.h) }}>
      <header><strong>{member.name}</strong><small>{memberText.mode(member)}</small></header>
      {member.taskLabel && <p className="team-card-task">{member.taskLabel}</p>}
      <p className="team-card-status">{status}{member.activityLabel ? ` · ${member.activityLabel}` : ''}</p>
      {ended && ended !== status && <p>{ended}</p>}
      {member.resultText && <p className="team-card-result">{member.resultText}</p>}
      {member.sources.status !== 'clean' && <p className="team-card-note">涉及外部来源，原文不在这里展开。</p>}
      {sent === 'accepted' && <p className="team-card-note" role="status">已请求停止；是否停下，以她的状态为准。</p>}
      {sent === 'failed' && <p className="team-card-note" role="alert">停止请求没有发出，请在协作面板里刷新核对。</p>}
      <div className="team-card-actions">
        {member.controls.interrupt && <button type="button" disabled={disabled} onClick={() => { void interrupt() }}>停止当前工作</button>}
        <button type="button" onClick={onMore}>更多</button>
        <button type="button" onClick={onClose}>收起</button>
      </div>
    </section>
  )
}

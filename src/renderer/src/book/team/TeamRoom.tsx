import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../../shared'
import type { AgentView } from '../../../../shared/collaboration'
import { sendCommand } from '../command'
import { memberTarget, memberText, memberWorkText } from '../CollaborationPanel'
import { activityKind } from '../../voice/activity-text'
import { durationText, useMemberElapsed, useMemberSteps } from './useMemberProgress'
import { assignStations, depthOf, memberFailed, memberKey, OCCLUDERS, poseOf, slotOf, type Place, type TeamPose, type TeamSlot } from './teamScene'
import { artOf, badgeOf, TEAM_SPRITES } from './teamArt'
import './team.css'

const files = import.meta.glob(['../../assets/character/taozi/team/room-day.webp', '../../assets/character/taozi/team/mini-v2-*.png'], { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const roomSrc = files['../../assets/character/taozi/team/room-day.webp']
const spriteSrc = (sprite: string) => files[`../../assets/character/taozi/team/mini-v2-${sprite}.png`]
/** The built-in character has team art; a custom character package without it keeps the close view. */
export const teamArtReady = !!roomSrc && TEAM_SPRITES.every((sprite) => !!spriteSrc(sprite))
const pct = (value: number) => `${(value * 100).toFixed(2)}%`

/**
 * The team view on the left page: the whole room, her at the desk, one mini 桃子 per helper. Places are stable, the pose
 * follows the member's facts (teamScene.ts), and clicking a helper opens a small card with what is known about her.
 * The room sits inside `.room`, so the daypart tint and the lamp light it like the close view.
 */
export function TeamRoom({ snapshot, bridge, members, visible, onMore }: {
  snapshot: AppSnapshot; bridge: AppBridge; members: readonly AgentView[]; visible: boolean; onMore(): void
}) {
  const slotsRef = useRef<ReadonlyMap<string, Place>>(new Map())
  const posesRef = useRef<ReadonlyMap<string, TeamPose>>(new Map())
  const slots = assignStations(slotsRef.current, members)
  slotsRef.current = slots
  const placed = members.flatMap((member) => {
    const key = memberKey(member), place = slots.get(key)
    if (!place) return []
    const pose = poseOf(member, posesRef.current.get(key))
    const slot = slotOf(place)
    return [{ member, place, slot: pose === 'resting' ? { ...slot, h: slot.h * .75 } : slot, pose, art: artOf(pose, place) }]
  })
  posesRef.current = new Map(placed.map(({ member, pose }) => [memberKey(member), pose]))
  const layers = [...OCCLUDERS.map((entry) => ({ kind: 'furniture' as const, depth: entry.depth, entry })),
    ...placed.map((entry) => ({ kind: 'member' as const, depth: depthOf(entry.slot), entry })),
    ...placed.filter((entry) => entry.art.foreground).map((entry) => ({ kind: 'tabletop' as const, depth: .8701, entry }))]
    .sort((a, b) => a.depth - b.depth)
  const offstage = members.length - placed.length
  const [openKey, setOpenKey] = useState<string | null>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const open = placed.find((entry) => memberKey(entry.member) === openKey)
  useEffect(() => { if (!visible) setOpenKey(null) }, [visible])
  const close = () => { const key = openKey; setOpenKey(null); if (key) buttons.current.get(key)?.focus() }

  return (
    <div className="team-room" data-visible={visible} aria-hidden={visible ? undefined : true} aria-label={visible ? '房间里的帮手' : undefined} role={visible ? 'group' : undefined}>
      <img className="team-room-art" src={roomSrc} alt="" draggable={false} />
      {layers.map((layer) => {
        if (layer.kind === 'furniture') return <img key={layer.entry.id} className="team-room-art team-occluder" data-occluder={layer.entry.id}
          src={roomSrc} alt="" aria-hidden draggable={false} style={{ clipPath: `polygon(${layer.entry.polygon})` }} />
        const { member, slot, pose, place, art } = layer.entry
        const key = memberKey(member)
        if (layer.kind === 'tabletop') return <img key={`${key}:tabletop`} className="team-tabletop" src={spriteSrc(art.sprite)} alt="" aria-hidden draggable={false}
          style={{ left: pct(slot.x), top: pct(slot.y), height: pct(slot.h), clipPath: art.foreground }} />
        const badge = badgeOf(member)
        return (
          <button key={key} ref={(node) => { if (node) buttons.current.set(key, node); else buttons.current.delete(key) }}
            type="button" className="team-mini" data-pose={pose} data-station={place.station} data-facing={slot.facing} data-failed={memberFailed(member) || undefined}
            data-busy={member.activity === 'running' || undefined} data-tool={member.work?.phase === 'tool' || undefined}
            data-sprite={art.sprite} data-activity={member.activity} data-outcome={member.outcome}
            style={{ left: pct(slot.x), top: pct(slot.y), height: pct(slot.h) }} tabIndex={visible ? 0 : -1}
            aria-label={`${member.name}：${memberText.status(member)}`} aria-haspopup="dialog" aria-expanded={openKey === key}
            onClick={() => setOpenKey(openKey === key ? null : key)}>
            <span className="team-mini-shadow" aria-hidden />
            <img src={spriteSrc(art.sprite)} alt="" draggable={false} />
            <span className="team-mini-hit" aria-hidden />
            {badge && <span className="team-status-mark" aria-hidden>{badge}</span>}
          </button>
        )
      })}
      {offstage > 0 && <button type="button" className="team-offstage" tabIndex={visible ? 0 : -1} onClick={onMore}>还有 {offstage} 位帮手</button>}
      {visible && open && <MemberCard key={`${snapshot.epoch}:${memberKey(open.member)}`} member={open.member} slot={open.slot} snapshot={snapshot} bridge={bridge} onClose={close} onMore={() => { setOpenKey(null); onMore() }} />}
    </div>
  )
}

/** What is known about one helper, and the one direct action: stop her current work. Everything else lives in the panel. */
function MemberCard({ member, slot, snapshot, bridge, onClose, onMore }: {
  member: AgentView; slot: TeamSlot; snapshot: AppSnapshot; bridge: AppBridge; onClose(): void; onMore(): void
}) {
  const ref = useRef<HTMLElement>(null)
  const [sent, setSent] = useState<'accepted' | 'failed' | null>(null)
  const elapsed = useMemberElapsed(snapshot, member)
  const details = useMemberSteps(bridge, member, snapshot.epoch)
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
      style={{ left: pct(Math.max(.18, Math.min(.82, slot.x))), top: pct(Math.max(.61, slot.y - slot.h)) }}>
      <header><strong>{member.name}</strong><small>{memberText.mode(member)}</small></header>
      {member.taskLabel && <p className="team-card-task">{member.taskLabel}</p>}
      <p className="team-card-status">{status}</p>
      {member.work && <p className="team-card-current">{memberWorkText(member)} · {durationText(elapsed)}</p>}
      {details.value?.steps.at(-1)?.status === 'running' && member.work?.phase === 'tool' && details.value.steps.at(-1)?.templateId === member.work.templateId && details.value.steps.at(-1)?.target
        && <p className="team-card-target">{details.value.steps.at(-1)?.target}</p>}
      <section className="team-card-history" aria-label="最近几步">
        <strong>最近几步</strong>
        {!details.value && <p className="team-card-note">{details.failed ? '暂时读不到步骤，请收起后重试。' : '正在读取…'}</p>}
        {details.value && !details.value.steps.length && <p className="team-card-note">还没有工具步骤。</p>}
        {!!details.value?.steps.length && <ol>{details.value.steps.map((step, index) => <li key={index}>
          <span>{activityKind(step) ?? '处理一步工作'} · {step.status === 'running' && member.activity !== 'running' ? '未收到结果' : { running: '进行中', completed: '已完成', failed: '未完成' }[step.status]}{step.durationMs !== null ? ` · ${durationText(step.durationMs)}` : ''}</span>
          {step.target && <small>{step.target}</small>}
        </li>)}</ol>}
      </section>
      <p className="team-card-note">已预留 {member.usage.admittedUnits.toLocaleString()} 单位{member.usage.inputTokens !== null && ` · 输入 ${member.usage.inputTokens} / 输出 ${member.usage.outputTokens ?? '未知'} tokens`}</p>
      {ended && ended !== status && <p>{ended}</p>}
      {member.resultText && <p className="team-card-result">{member.resultText}</p>}
      {(member.sources.status !== 'clean' || details.value?.withheld) && <p className="team-card-note">涉及外部来源，只显示步骤种类。</p>}
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

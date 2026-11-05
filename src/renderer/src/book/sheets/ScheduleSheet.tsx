import { useState } from 'react'
import type { AppBridge, AppSnapshot, CandidateView, LifeWorkItem, LifeWorkView } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { sendCommand, type CommandBody } from '../command'
import { formatClock, formatIso } from '../format'
import { fill } from '../life/text'
import { locationLabel } from '../labels'
import { SettingsIssue } from '../../tools/SettingsIssue'
import { PomodoroSettings } from '../../tools/PomodoroSettings'
import { visibleWorks } from './schedule'

/**
 * 日程：今天的番茄、她今天的去处和书桌作品、接下来你确认过的事。
 * 她的生活只在这里留一句自然的近况——不列几点看书、几点没做成，也不放遥控她去哪儿的按钮；
 * 想让她出门或早点回来，在对话里跟她说就够了。
 */
export function ScheduleSheet({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const { pomodoro, life, mailbox } = snapshot
  const [failed, setFailed] = useState(false)
  const [mailError, setMailError] = useState('')
  const command = async (body: CommandBody) => setFailed(!(await sendCommand(bridge, snapshot.epoch, body)).ok)
  const mail = async (body: CommandBody) => {
    const result = await sendCommand(bridge, snapshot.epoch, body)
    setMailError(result.ok ? '' : result.code)
  }
  const mailStatus = mailbox ? (copy.schedule.mail as Record<string, string>)[mailbox.status] : ''
  const mailBlocked = !mailbox || snapshot.companion.lightsOut || ['blocked', 'disabled', 'scanning'].includes(mailbox.status)
  const plan = pomodoro.plan && pomodoro.plan.status !== 'proposed' ? pomodoro.plan : null
  const done = pomodoro.completedCount ?? Math.max(0, pomodoro.focusIndex - (pomodoro.phase === 'focus' ? 1 : 0))
  const away = life?.outings.findLast((outing) => outing.status === 'away')
  const proposed = life?.outings.findLast((outing) => outing.status === 'proposed')
  const start = dayStart(snapshot)
  const finishedToday = (life?.outings ?? []).filter((outing) => (outing.status === 'returned' || outing.status === 'cut_short') && (outing.settledAtMs ?? outing.returnsAtMs) >= start).slice(-2)
  const work = life?.work
  const jobs = visibleWorks(life)
  const next = snapshot.candidates.filter((candidate) => candidate.status === 'confirmed').map((candidate) => ({ candidate, iso: whenOf(candidate) }))
    .sort((a, b) => (a.iso ?? '9').localeCompare(b.iso ?? '9'))

  const herNow = away
    ? fill(copy.schedule.outing.away, { place: copy.places[away.place as keyof typeof copy.places] ?? locationLabel(away.place), time: formatClock(away.returnsAtMs) })
    : proposed
      ? fill(copy.schedule.outing.proposed, { place: copy.places[proposed.place as keyof typeof copy.places] ?? locationLabel(proposed.place) })
      : copy.schedule.herInRoom
  const herWas = finishedToday.map((outing) => fill(copy.schedule.outing.returned, { place: copy.places[outing.place as keyof typeof copy.places] ?? locationLabel(outing.place) }))

  return (
    <section className="page page-right sheet" aria-label={copy.schedule.title}>
      <header className="page-head">
        <span className="page-date">{copy.schedule.title}</span>
        {life && <span className="sheet-lead">{copy.schedule.routine[life.userSchedule]}</span>}
      </header>
      <div className="sheet-body">
        <div className="schedule-pomodoro"><PomodoroSettings bridge={bridge} snapshot={snapshot} /></div>
        <h2 className="sheet-section">{copy.schedule.today}</h2>
        {plan ? (
          <div className="schedule-plan">
            <p className="schedule-line"><strong>{plan.label}</strong><span>{fill(copy.schedule.done, { done, total: pomodoro.plannedCount })}</span></p>
            {plan.items && plan.items.length > 0 && (
              <ul className="schedule-items">{plan.items.map((item, index) => <li key={index}><span>{item.text}</span><span className="schedule-count">×{item.count}</span></li>)}</ul>
            )}
          </div>
        ) : <p className="sheet-empty">{copy.schedule.noPlan}</p>}

        <h2 className="sheet-section">{copy.schedule.her}</h2>
        <ul className="schedule-her">
          <li><span>{herNow}</span></li>
          {herWas.map((text, index) => <li key={`was-${index}`} data-state="settled"><span>{text}</span></li>)}
        </ul>
        {away && <div className="card-actions schedule-life-actions">
          <button type="button" className="btn btn-ghost btn-small" onClick={() => void command({ type: 'life.return' })}>{copy.schedule.callBack}</button>
        </div>}
        {work?.enabled && (
          <>
            {jobs.length > 0 && <ul className="schedule-works">{jobs.map((job) => <WorkRow key={job.id} job={job} work={work} onCommand={(body) => { void command(body) }} />)}</ul>}
            {failed && <span className="notice-mark" title="没办成，稍后再试">！</span>}
          </>
        )}

        <h2 className="sheet-section">{copy.schedule.next}</h2>
        {next.length === 0 ? <p className="sheet-empty">{copy.schedule.nextEmpty}</p> : (
          <ul className="schedule-next">
            {next.map(({ candidate, iso }) => (
              <li key={candidate.id}>
                <span className="card-tag">{copy.schedule.kinds[candidate.kind]}</span>
                <span className="schedule-title">{candidate.title}</span>
                <time>{formatIso(iso)}</time>
              </li>
            ))}
          </ul>
        )}

        {mailbox && <>
          <h2 className="sheet-section">{copy.schedule.mail.title}</h2>
          <div className="schedule-mail" data-source={mailbox.source} data-status={mailbox.status}>
            <p className="schedule-line"><strong>{mailbox.folderLabel}</strong><span>{mailStatus}</span></p>
            {mailbox.status === 'blocked' && <p className="flow-note">{copy.schedule.mail.blocked}</p>}
            {mailbox.status === 'failed' && <p className="flow-note">{copy.schedule.mail.failed}</p>}
            {mailbox.status === 'disabled' && <p className="flow-note">{copy.schedule.mail.disabled}</p>}
            <div className="card-actions">
              <button type="button" className="btn btn-ghost btn-small" disabled={mailBlocked}
                onClick={() => void mail({ type: 'mail.scan' })}>{mailbox.source === 'fake' ? copy.schedule.mail.scanFake : copy.schedule.mail.scan}</button>
              <button type="button" className="btn btn-ghost btn-small" disabled={!snapshot.candidates.some((item) => item.status === 'confirmed')}
                onClick={() => void mail({ type: 'campus.export' })}>{copy.schedule.mail.export}</button>
            </div>
            <p className="flow-note">{copy.schedule.mail.hint}</p>
            <SettingsIssue code={mailError} />
          </div>
        </>}
      </div>
    </section>
  )
}

/** 一件书桌作品：读哪份材料／照着哪份写、做到第几步；停下、接着做、看看最新的成品 */
function WorkRow({ job, work, onCommand }: { job: LifeWorkItem; work: LifeWorkView; onCommand: (body: CommandBody) => void }) {
  const material = work.materials.find((item) => item.id === job.materialId)
  const name = material ? baseName(material.path) : '书桌上的材料'
  const text = fill(copy.schedule.works[job.kind], { name })
  const reason = job.reason && job.status !== 'completed' && job.status !== 'running' ? copy.schedule.works.reason[job.reason] : ''
  return (
    <li className="work-row" data-status={job.status} data-work-id={job.id}>
      <span className="work-kind" aria-hidden>{job.kind === 'read' ? '读' : '写'}</span>
      <span className="work-text">{text}{(job.source === 'fake' || material?.source === 'fake') && <small className="demo-tag">{copy.shelf.fake}</small>}</span>
      <span className="work-progress" role="img" aria-label={fill(copy.schedule.works.progress, { done: job.completedSteps, total: job.totalSteps })}>
        {Array.from({ length: job.totalSteps }, (_, index) => <span key={index} data-done={index < job.completedSteps} />)}
      </span>
      <small className="work-status">{copy.schedule.works.status[job.status]}{reason && ` · ${reason}`}</small>
      <span className="work-actions">
        {job.status === 'running' && <button type="button" className="link-button" onClick={() => onCommand({ type: 'life.work.pause', workId: job.id })}>{copy.schedule.works.pause}</button>}
        {(job.status === 'paused' || job.status === 'interrupted') && <button type="button" className="link-button" onClick={() => onCommand({ type: 'life.work.resume', workId: job.id })}>{copy.schedule.works.resume}</button>}
        {job.output && <button type="button" className="link-button" onClick={() => onCommand({ type: 'life.work.open', workId: job.id })}>{copy.schedule.works.open}</button>}
      </span>
    </li>
  )
}

const baseName = (path: string) => (path.split(/[\\/]/).at(-1) ?? path).replace(/\.[^.]+$/, '')
const whenOf = (candidate: CandidateView) => candidate.kind === 'event' ? candidate.eventStartIso ?? candidate.deadlineIso : candidate.deadlineIso

/** 今天 0 点（UTC+8）：只列今天的外出 */
function dayStart(snapshot: AppSnapshot): number {
  const offset = 8 * 3600_000
  return Math.floor((snapshot.clock.nowMs + offset) / 86_400_000) * 86_400_000 - offset
}

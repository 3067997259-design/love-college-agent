import { useState } from 'react'
import type { AppBridge, AppSnapshot, CandidateView, LifeWorkItem, LifeWorkView, OutingPlace } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { sendCommand, type CommandBody } from '../command'
import { civilFromDays, formatClock, formatIso } from '../format'
import { dayKeyLabel, fill } from '../life/text'
import { locationLabel } from '../labels'
import { SettingsIssue } from '../../tools/SettingsIssue'
import { visibleWorks } from './schedule'

/**
 * 日程用来看今天：专注排到哪了、她在哪、接下来有什么事。
 * 排专注、让她出门或回来、看邮件，都是你在对话里跟她说，她用自己的工具去做；她排的专注要你点头才算数。
 * 这页只留两类操作：她书桌作品的看看、暂停、接着做，以及把确认过的事导出成日历文件（校园插件约定导出由你在书页上做）。
 */
export function ScheduleSheet({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const { pomodoro, life } = snapshot
  const [failed, setFailed] = useState(false)
  const [exportError, setExportError] = useState('')
  const command = async (body: CommandBody) => setFailed(!(await sendCommand(bridge, snapshot.epoch, body)).ok)
  const exportCalendar = async () => {
    const result = await sendCommand(bridge, snapshot.epoch, { type: 'campus.export' })
    setExportError(result.ok ? '' : result.code)
  }
  const start = dayStart(snapshot)
  const today = dayKeyLabel(dayKeyOf(start), true)
  const routine = life && life.userSchedule !== 'auto' ? copy.schedule.routine[life.userSchedule] : ''
  const plan = pomodoro.plan && pomodoro.plan.status !== 'proposed' ? pomodoro.plan : null
  const waiting = !plan && (Boolean(pomodoro.proposal) || pomodoro.plan?.status === 'proposed')
  const done = pomodoro.completedCount ?? Math.max(0, pomodoro.focusIndex - (pomodoro.phase === 'focus' ? 1 : 0))
  const away = life?.outings.findLast((outing) => outing.status === 'away')
  const proposed = life?.outings.findLast((outing) => outing.status === 'proposed')
  const finishedToday = (life?.outings ?? []).filter((outing) => (outing.status === 'returned' || outing.status === 'cut_short') && (outing.settledAtMs ?? outing.returnsAtMs) >= start).slice(-2)
  const work = life?.work
  const jobs = visibleWorks(life)
  const next = snapshot.candidates.filter((candidate) => candidate.status === 'confirmed').map((candidate) => ({ candidate, iso: whenOf(candidate) }))
    .sort((a, b) => (a.iso ?? '9').localeCompare(b.iso ?? '9'))

  const herNow = away ? fill(copy.schedule.outing.away, { place: placeName(away.place), time: formatClock(away.returnsAtMs) })
    : proposed ? fill(copy.schedule.outing.proposed, { place: placeName(proposed.place) })
    : copy.schedule.herInRoom
  const herWas = finishedToday.map((outing) => fill(outing.status === 'cut_short' ? copy.schedule.outing.cut_short : copy.schedule.outing.returned, { place: placeName(outing.place) }))

  return (
    <section className="page page-right sheet" aria-label={copy.schedule.title}>
      <header className="page-head">
        <span className="page-date">{copy.schedule.title}</span>
        <span className="sheet-lead">{routine ? `${today} · ${routine}` : today}</span>
      </header>
      <div className="sheet-body">
        <h2 className="sheet-section">{copy.schedule.focus}</h2>
        {plan ? (
          <div className="schedule-plan">
            <p className="schedule-line"><strong>{plan.label}</strong><span>{fill(copy.schedule.done, { done, total: pomodoro.plannedCount })}</span></p>
            {plan.items && plan.items.length > 0 && (
              <ul className="schedule-items">{plan.items.map((item, index) => <li key={index}><span>{item.text}</span><span className="schedule-count">×{item.count}</span></li>)}</ul>
            )}
          </div>
        ) : <p className="sheet-empty">{waiting ? copy.schedule.waiting : copy.schedule.noPlan}</p>}

        <h2 className="sheet-section">{copy.schedule.her}</h2>
        <ul className="schedule-her">
          <li>{herNow}</li>
          {herWas.map((text, index) => <li key={index} data-state="settled">{text}</li>)}
        </ul>
        {work?.enabled && jobs.length > 0 && <>
          <ul className="schedule-works">{jobs.map((job) => <WorkRow key={job.id} job={job} work={work} onCommand={(body) => { void command(body) }} />)}</ul>
          {failed && <span className="notice-mark" title="没办成，稍后再试">！</span>}
        </>}

        <h2 className="sheet-section">{copy.schedule.next}</h2>
        {next.length === 0 ? <p className="sheet-empty">{copy.schedule.nextEmpty}</p> : <>
          <ul className="schedule-next">
            {next.map(({ candidate, iso }) => (
              <li key={candidate.id}>
                <span className="card-tag">{copy.schedule.kinds[candidate.kind]}</span>
                <span className="schedule-title">{candidate.title}</span>
                <time>{formatIso(iso)}</time>
              </li>
            ))}
          </ul>
          <div className="card-actions">
            <button type="button" className="btn btn-ghost btn-small" disabled={snapshot.companion.lightsOut} onClick={() => void exportCalendar()}>{copy.schedule.export}</button>
          </div>
          <SettingsIssue code={exportError} />
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

const UTC8 = 8 * 3600_000
const pad = (n: number) => String(n).padStart(2, '0')
/** 某天 0 点（UTC+8）的时间戳 → 'YYYY-MM-DD'；渲染层不用 Date */
const dayKeyOf = (ms: number) => { const { year, month, day } = civilFromDays(Math.floor((ms + UTC8) / 86_400_000)); return `${year}-${pad(month)}-${pad(day)}` }
const placeName = (place: OutingPlace) => copy.places[place as keyof typeof copy.places] ?? locationLabel(place)
const baseName = (path: string) => (path.split(/[\\/]/).at(-1) ?? path).replace(/\.[^.]+$/, '')
const whenOf = (candidate: CandidateView) => candidate.kind === 'event' ? candidate.eventStartIso ?? candidate.deadlineIso : candidate.deadlineIso

/** 今天 0 点（UTC+8）：只列今天的外出 */
function dayStart(snapshot: AppSnapshot): number {
  return Math.floor((snapshot.clock.nowMs + UTC8) / 86_400_000) * 86_400_000 - UTC8
}

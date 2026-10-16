import { useState } from 'react'
import type { AppBridge, AppSnapshot, CandidateView, LifeWorkItem, LifeWorkView } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { sendCommand, type CommandBody } from '../command'
import { formatClock, formatIso } from '../format'
import { fill } from '../life/text'

/**
 * 日程：今天的番茄、她今天的安排和书桌作品、接下来你确认过的事。
 * 全部来自快照：番茄的完成数、她的作息和出返时刻、作品做到第几步都由主进程定（技术方案 §3.5、§3.14），
 * 候选只列已确认的。作品只有元数据，正文要看就点“看看”走原生预览，不在这里读。
 */
export function ScheduleSheet({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const { pomodoro, life } = snapshot
  const [failed, setFailed] = useState(false)
  const command = async (body: CommandBody) => setFailed(!(await sendCommand(bridge, snapshot.epoch, body)).ok)
  const plan = pomodoro.plan && pomodoro.plan.status !== 'proposed' ? pomodoro.plan : null
  const done = pomodoro.completedCount ?? Math.max(0, pomodoro.focusIndex - (pomodoro.phase === 'focus' ? 1 : 0))
  // 她今天：作息里的安排，加上今天的外出和还没结束的（提议中、在外面），按时刻排
  const her = [
    ...(life?.agenda ?? []).map((entry, index) => ({ key: `a${index}`, at: entry.atMs, state: entry.state as string, text: copy.schedule.agenda[entry.kind], note: copy.schedule.agendaState[entry.state] })),
    ...(life?.outings ?? []).filter((outing) => outing.startsAtMs >= dayStart(snapshot) || outing.status === 'proposed' || outing.status === 'away')
      .map((outing) => ({ key: outing.id, at: outing.startsAtMs, state: outing.status as string, text: fill(copy.schedule.outing[outing.status], { place: copy.places[outing.place], time: formatClock(outing.returnsAtMs) }), note: '' })),
  ].sort((a, b) => a.at - b.at)
  const work = life?.work
  // An unfinished old work remains reachable after a day change/restart, especially interrupted jobs.
  const jobs = (work?.jobs ?? []).filter((job) => job.dayKey === life?.dayKey || job.status !== 'completed')
  const next = snapshot.candidates.filter((candidate) => candidate.status === 'confirmed').map((candidate) => ({ candidate, iso: whenOf(candidate) }))
    .sort((a, b) => (a.iso ?? '9').localeCompare(b.iso ?? '9'))

  return (
    <section className="page page-right sheet" aria-label={copy.schedule.title}>
      <header className="page-head">
        <span className="page-date">{copy.schedule.title}</span>
        {life && <span className="sheet-lead">{copy.schedule.routine[life.userSchedule]}</span>}
      </header>
      <div className="sheet-body">
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
        {her.length === 0 && jobs.length === 0 ? <p className="sheet-empty">{copy.schedule.herEmpty}</p> : (
          <ul className="schedule-her">
            {her.map((entry) => (
              <li key={entry.key} data-state={entry.state}>
                <time>{formatClock(entry.at)}</time><span>{entry.text}</span><small>{entry.note}</small>
              </li>
            ))}
          </ul>
        )}
        {work?.enabled && (
          <>
            {jobs.length > 0 && <ul className="schedule-works">{jobs.map((job) => <WorkRow key={job.id} job={job} work={work} onCommand={(body) => { void command(body) }} />)}</ul>}
            <div className="card-actions">
              {(['read', 'write'] as const).filter((kind) => !jobs.some((job) => job.kind === kind)).map((kind) => (
                <button key={kind} type="button" className="btn btn-ghost btn-small" disabled={work.attemptsToday >= work.dailyAttemptLimit}
                  onClick={() => { void command({ type: 'life.work.start', kind }) }}>{kind === 'read' ? copy.schedule.works.startRead : copy.schedule.works.startWrite}</button>
              ))}
              {failed && <span className="notice-mark" title="没办成，稍后再试">！</span>}
            </div>
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
      <span className="work-text">{text}{job.source === 'fake' && <small className="demo-tag">{copy.shelf.fake}</small>}</span>
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

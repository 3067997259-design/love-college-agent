import type { AppSnapshot, CandidateView } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { formatClock, formatIso } from '../format'
import { fill } from '../life/text'

/**
 * 日程：今天的番茄、她今天的安排、接下来你确认过的事。
 * 全部来自快照：番茄的完成数、她的作息和出返时刻由主进程定（技术方案 §3.5、§3.14），候选只列已确认的。
 */
export function ScheduleSheet({ snapshot }: { snapshot: AppSnapshot }) {
  const { pomodoro, life } = snapshot
  const plan = pomodoro.plan && pomodoro.plan.status !== 'proposed' ? pomodoro.plan : null
  const done = pomodoro.completedCount ?? Math.max(0, pomodoro.focusIndex - (pomodoro.phase === 'focus' ? 1 : 0))
  // 她今天：作息里的安排，加上今天的外出和还没结束的（提议中、在外面），按时刻排
  const her = [
    ...(life?.agenda ?? []).map((entry, index) => ({ key: `a${index}`, at: entry.atMs, state: entry.state as string, text: copy.schedule.agenda[entry.kind], note: copy.schedule.agendaState[entry.state] })),
    ...(life?.outings ?? []).filter((outing) => outing.startsAtMs >= dayStart(snapshot) || outing.status === 'proposed' || outing.status === 'away')
      .map((outing) => ({ key: outing.id, at: outing.startsAtMs, state: outing.status as string, text: fill(copy.schedule.outing[outing.status], { place: copy.places[outing.place], time: formatClock(outing.returnsAtMs) }), note: '' })),
  ].sort((a, b) => a.at - b.at)
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
        {her.length === 0 ? <p className="sheet-empty">{copy.schedule.herEmpty}</p> : (
          <ul className="schedule-her">
            {her.map((entry) => (
              <li key={entry.key} data-state={entry.state}>
                <time>{formatClock(entry.at)}</time><span>{entry.text}</span><small>{entry.note}</small>
              </li>
            ))}
          </ul>
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

const whenOf = (candidate: CandidateView) => candidate.kind === 'event' ? candidate.eventStartIso ?? candidate.deadlineIso : candidate.deadlineIso

/** 今天 0 点（UTC+8）：只列今天的外出 */
function dayStart(snapshot: AppSnapshot): number {
  const offset = 8 * 3600_000
  return Math.floor((snapshot.clock.nowMs + offset) / 86_400_000) * 86_400_000 - offset
}

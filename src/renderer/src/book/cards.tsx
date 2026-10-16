import { useEffect, useRef, useState } from 'react'
import type { AppBridge, CandidateView, DeliveryView, EvidenceView, PlanStep, TaskView, ActivityView } from '../../../shared'
import { activityText } from '../voice/activity-text'
import { formatIso } from './format'

/* —— 候选卡：证据 → 候选 → 确认，要让评委亲眼看到（体验设计 §2） —— */
export function CandidateCard({ view, bridge, onCommand, entering }: {
  view: CandidateView
  bridge: AppBridge
  onCommand: (type: 'candidate.confirm' | 'candidate.ignore', id: string, revision: number, plannedCompletionIso?: string | null) => void
  entering: boolean
}) {
  const [evidence, setEvidence] = useState<EvidenceView | 'loading' | 'failed' | null>(null)
  const [previousEvidence, setPreviousEvidence] = useState<EvidenceView | 'loading' | 'failed' | null>(null)
  const [planned, setPlanned] = useState('')
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [])
  const open = evidence !== null

  async function toggleEvidence() {
    const id = ++request.current
    if (open) { setEvidence(null); return }
    setEvidence('loading')
    try { const next = await bridge.readEvidence(view.evidenceRef); if (request.current === id) setEvidence(next) }
    catch { if (request.current === id) setEvidence('failed') }
  }

  return (
    <article className="card card-candidate" data-status={view.status} data-kind={view.kind} data-entering={entering}>
      <header className="card-head">
        <span className="card-source">{view.sourceLabel}</span>
        <span className="card-tag">{view.source === 'fake' ? '合成 · ' : ''}{view.kind === 'event' ? '活动' : '截止'}</span>
      </header>
      <h3 className="card-title">{view.title}</h3>
      <dl className="card-times">
        {view.kind === 'event' && view.eventStartIso && <><dt>活动时间</dt><dd>{formatIso(view.eventStartIso)}{view.eventEndIso ? ` — ${formatIso(view.eventEndIso)}` : ''}</dd></>}
        {view.locationText && <><dt>地点</dt><dd>{view.locationText}</dd></>}
        <dt>{view.kind === 'event' ? '报名截止' : '原始截止'}</dt><dd className="time-deadline">{formatIso(view.deadlineIso)}</dd>
        <dt>计划完成</dt><dd className="time-planned">{formatIso(view.plannedCompletionIso)}</dd>
      </dl>
      {view.status === 'changed' && <div className="card-note"><p>变更待确认；已接受的截止仍为 {formatIso(view.change?.previousDeadlineIso ?? null)}。</p>
        {view.change && <button type="button" className="link-button" onClick={() => {
          if (previousEvidence) { setPreviousEvidence(null); return }
          setPreviousEvidence('loading'); void bridge.readEvidence(view.change!.previousEvidenceRef).then(setPreviousEvidence, () => setPreviousEvidence('failed'))
        }}>{previousEvidence ? '收起原确认邮件' : '看原确认邮件'}</button>}
        {previousEvidence && <Evidence state={previousEvidence} />}
      </div>}

      <button className="link-button" onClick={() => void toggleEvidence()} aria-expanded={open}>
        {open ? '收起原文' : '看原文'}
      </button>
      {open && <Evidence state={evidence} />}

      {view.status === 'confirmed'
        ? <p className="card-stamp">已确认</p>
        : view.status === 'ignored'
          ? <p className="card-stamp card-stamp-muted">已忽略</p>
          : (
            <footer className="card-actions">
              <label>计划完成时间（上海，可留空）<input type="datetime-local" aria-label="计划完成时间" value={planned} onChange={(event) => setPlanned(event.target.value)} /></label>
              <button className="btn btn-primary" onClick={() => onCommand('candidate.confirm', view.id, view.revision ?? 1, planned ? planned + (planned.length === 16 ? ':00' : '') + '+08:00' : undefined)}>确认</button>
              <button className="btn btn-ghost" onClick={() => onCommand('candidate.ignore', view.id, view.revision ?? 1)}>忽略</button>
            </footer>
          )}
    </article>
  )
}

function Evidence({ state }: { state: EvidenceView | 'loading' | 'failed' | null }) {
  if (state === 'loading' || state === null) return <div className="evidence evidence-loading">取原文……</div>
  if (state === 'failed') return <div className="evidence"><span className="notice-mark">！</span>原文取不到。卡片上的时间先别当真。</div>
  // 高亮是 excerpt 的 UTF-16 半开区间；按起点排序后切片
  const parts: { text: string; mark: boolean }[] = []
  let cursor = 0
  for (const h of [...state.highlights].sort((a, b) => a.start - b.start)) {
    if (h.start < cursor) continue
    if (h.start > cursor) parts.push({ text: state.excerpt.slice(cursor, h.start), mark: false })
    parts.push({ text: state.excerpt.slice(h.start, h.end), mark: true })
    cursor = h.end
  }
  parts.push({ text: state.excerpt.slice(cursor), mark: false })
  return (
    <blockquote className="evidence">
      <div className="evidence-meta">{state.senderName} · {state.subject}</div>
      <div className="evidence-body">{parts.map((p, i) => p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</div>
    </blockquote>
  )
}

/* —— 交付卡：从左页越过中缝来到右页，点开就是真实文件 —— */
const KIND_LABEL = { calendar: '日程', markdown: '整理', document: '文件', gift: '礼物' } as const

export function DeliveryCard({ view, onOpen, entering }: { view: DeliveryView; onOpen: (artifactId: string) => void; entering: boolean }) {
  return (
    <article className="card card-delivery" data-kind={view.kind} data-status={view.status} data-entering={entering}>
      <span className="delivery-icon" data-kind={view.kind} aria-hidden />
      <div className="delivery-body">
        <span className="card-source">{view.source === 'fake' ? '合成 · ' : ''}{KIND_LABEL[view.kind]}</span>
        <span className="delivery-name">{view.displayName}</span>
      </div>
      {view.status === 'ready'
        ? <button className="btn btn-primary" onClick={() => onOpen(view.artifactId)}>打开</button>
        : <span className="notice-mark" title="没有生成出来">！</span>}
    </article>
  )
}

/* —— 任务卡：update_plan 的步骤逐项打勾，下面是手写体的活动小字 —— */
const STEP_MARK: Record<PlanStep['status'], string> = { pending: '', active: '…', done: '✓', failed: '！' }

export function TaskCard({ task, activities }: { task: TaskView; activities: readonly ActivityView[] }) {
  const mine = activities.filter((a) => a.taskId === task.id)
  return (
    <section className="task" data-status={task.status}>
      <ol className="task-steps">
        {task.steps.map((s) => (
          <li key={s.id} data-status={s.status}><span className="step-box" aria-hidden>{STEP_MARK[s.status]}</span>{s.text}</li>
        ))}
      </ol>
      {mine.length > 0 && (
        <ul className="activities">
          {mine.map((a) => (
            <li key={a.id} className="activity" data-status={a.status}>
              {activityText(a)}{a.error && <span className="notice-mark" title={a.error.detailsId ? `诊断编号 ${a.error.detailsId}` : undefined}>！</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

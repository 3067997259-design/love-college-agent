import { useEffect, useRef, useState } from 'react'
import type { AppBridge, BackupView, CandidateView, DeliveryView, EvidenceView, PlanStep, PomodoroPlanItem, PomodoroPlanView, PomodoroView, TaskView, ActivityView } from '../../../shared'
import { activityText } from '../voice/activity-text'
import { formatDateTime, formatIso } from './format'
import { QuillArt } from './quill/QuillArt'
import { formatSpan, planSpanMs, rhythmText, tomatoStates, type TomatoState } from './plan'

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
  const previousRequest = useRef(0)
  useEffect(() => () => { request.current++; previousRequest.current++ }, [])
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
        {view.change?.previousEventStartIso && <p>原活动时间：{formatIso(view.change.previousEventStartIso)}</p>}
        <p>确认后导出同 UID 的新版本；若日历重复添加，请手动删除旧项。</p>
        {view.change && <button type="button" className="link-button" onClick={() => {
          const id = ++previousRequest.current
          if (previousEvidence) { setPreviousEvidence(null); return }
          setPreviousEvidence('loading'); void bridge.readEvidence(view.change!.previousEvidenceRef).then((value) => { if (previousRequest.current === id) setPreviousEvidence(value) }, () => { if (previousRequest.current === id) setPreviousEvidence('failed') })
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

/* —— 番茄计划卡：她（或你）排的草案，你确认才生效；确认后顶部出现今天的番茄格（技术方案 §3.5） —— */
export function PlanCard({ plan, pomodoro, entering, onConfirm, onDismiss }: {
  plan: PomodoroPlanView
  pomodoro: PomodoroView
  entering: boolean
  onConfirm: () => void
  onDismiss: () => void
}) {
  const proposal = plan.status === 'proposed'
  // 草案的番茄数是今天的总数：已经做完的照主进程的进度画，不从草案重新起算
  const view = proposal ? { ...pomodoro, plannedCount: plan.plannedCount } : pomodoro
  const states = tomatoStates(view)
  const done = pomodoro.completedCount ?? states.filter((state) => state === 'done').length
  const allDone = pomodoro.focusIndex >= plan.plannedCount
  const replacing = proposal && pomodoro.plan && pomodoro.plan !== plan && pomodoro.plan.status === 'confirmed'
  return (
    <article className="card card-plan" data-status={plan.status} data-entering={entering}>
      <header className="card-head">
        <span className="card-source">{plan.source === 'assistant' ? '她排的' : '你排的'}</span>
        <span className="card-tag">{plan.timing === 'demo' ? '演示节奏' : `${plan.plannedCount} 个番茄`}</span>
      </header>
      <h3 className="card-title">{plan.label}</h3>
      {plan.items?.length
        ? <PlanItems items={plan.items} states={states} />
        : (
          <div className="plan-tomatoes" role="img" aria-label={`${plan.plannedCount} 个番茄`}>
            {states.map((state, i) => <span key={i} className="tomato" data-state={state} />)}
          </div>
        )}
      <p className="plan-rhythm">{rhythmText(plan)}<span className="plan-span">，一共约 {formatSpan(planSpanMs(plan))}</span></p>
      {replacing && <p className="plan-replace">确认后换掉今天的计划；已经做完的 {done} 个照算。</p>}
      {plan.status === 'proposed'
        ? (
          <footer className="card-actions">
            <button className="btn btn-primary" onClick={onConfirm}>就这么排</button>
            <button className="btn btn-ghost" onClick={onDismiss}>不用了</button>
          </footer>
        )
        : plan.status === 'confirmed'
          ? <p className="card-stamp">排进今天了</p>
          : <p className={allDone ? 'card-stamp' : 'card-stamp card-stamp-muted'}>{allDone ? '做完了' : '收起了'}</p>}
    </article>
  )
}

/** 计划条目按顺序占番茄：第一条占前 count 个，依此类推；她能同时帮忙的标出来（技术方案 §3.5） */
function PlanItems({ items, states }: { items: readonly PomodoroPlanItem[]; states: readonly TomatoState[] }) {
  let offset = 0
  return (
    <ul className="plan-items">
      {items.map((item, i) => {
        const mine = states.slice(offset, offset + item.count)
        offset += item.count
        const done = mine.length > 0 && mine.every((state) => state === 'done')
        return (
          <li key={i} data-done={done}>
            <span className="plan-item-text">{item.text}</span>
            {item.assist && <span className="plan-assist">她帮忙</span>}
            <span className="plan-item-tomatoes" role="img" aria-label={`${item.count} 个番茄`}>
              {mine.map((state, j) => <span key={j} className="tomato" data-state={state} />)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/* —— 礼物卡：做完第一件真事以后，她把羽毛笔从左页递过来（第 13 镜）。预制礼物，不说成实时生成 —— */
export function GiftCard({ entering }: { entering: boolean }) {
  return (
    <article className="card card-gift" data-entering={entering}>
      <QuillArt className="gift-quill" />
      <div className="gift-body">
        <span className="card-source">她送你的</span>
        <h3 className="card-title">一支羽毛笔</h3>
        <p className="gift-text">做完第一件事以后，她把这支笔递给你。以后的私人存档，都从书缝里这支笔导出。</p>
      </div>
    </article>
  )
}

/* —— 恢复结果卡：应用重启后才看得到；数字来自存档清单，不是渲染层自己数的 —— */
export function RestoreCard({ view, onDone }: { view: BackupView; onDone: () => void }) {
  const restored = view.status === 'restored'
  const incoming = view.incoming
  return (
    <article className="card card-restore" data-status={view.status}>
      <h3 className="card-title">{restored ? '存档恢复了' : '这次没恢复成功'}</h3>
      {restored && incoming && (
        <p className="restore-detail">
          来自 {formatDateTime(incoming.savedAtMs)} 的{incoming.source === 'fake' ? '开发' : ''}存档：{incoming.pageCount} 页对话、{incoming.messageCount} 条聊天、{incoming.memoryCount} 条记忆、{incoming.deliveryCount} 份交付。
        </p>
      )}
      <p className="restore-note">
        {restored
          ? (view.safetyBackupId ? '恢复之前，原来的数据先另存了一份。' : '')
          : '现在用的还是恢复前的数据。'}
        {!restored && view.error?.detailsId && <span className="notice-mark" title={`诊断编号 ${view.error.detailsId}`}>！</span>}
      </p>
      <footer className="card-actions">
        <button className="btn btn-primary" onClick={onDone}>{restored ? '好' : '知道了'}</button>
      </footer>
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

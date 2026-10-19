import type { TaskCardView } from '../../../../shared'
import book from '../../voice/book.zh.json'

/**
 * D1 task card in the conversation flow. It only renders the main-process projection; approving a
 * concrete plan version and closing the task are user actions dispatched from here. No button ever
 * grants a global mode or a scope wider than "desk writes + per-command approvals".
 */
export function TaskObjectCard({ view, onApprove, onClose }: {
  view: TaskCardView
  onApprove(taskId: string, planVersion: number): void
  onClose(taskId: string, status: 'completed' | 'abandoned'): void
}) {
  const words = book.taskObject
  const plan = view.plan
  const stepMark = (status: string) => status === 'done' ? '✓' : status === 'failed' ? '✕' : status === 'active' ? '→' : '·'
  return (
    <article className="card task-object" data-task-id={view.id} data-task-status={view.status} aria-label={words.label + '：' + view.title}>
      <header className="card-head">
        <span className="card-tag">{words.label}</span>
        <span className="task-object-status" data-status={view.status}>{words.status[view.status]}</span>
      </header>
      <h3 className="card-title task-object-title">{view.title}</h3>
      {plan && <div className="task-object-plan">
        <p className="task-object-version">{words.planVersion.replace('{version}', String(plan.version))}</p>
        <ol className="task-object-steps">
          {plan.steps.map((step) => (
            <li key={step.id} data-step-id={step.id} data-step-status={step.status}>
              <span className="task-object-step-mark" aria-hidden>{stepMark(step.status)}</span>
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
      </div>}
      {view.approval
        ? <p className="card-note task-object-scope">{words.approvedScope}</p>
        : <p className="card-note task-object-wait">{words.waitingApproval}</p>}
      {view.checkpoints.length > 0 && <p className="task-object-checkpoints">{words.checkpoints.replace('{n}', String(view.checkpoints.length))}</p>}
      {view.latestHandoff && <div className="task-object-handoff" data-handoff-id={view.latestHandoff.id}>
        <p className="task-object-version">交班检查点 · {view.latestHandoff.source === 'fallback' ? '代码兜底' : '她整理'}</p>
        {view.latestHandoff.completed.length > 0 && <p className="task-object-handoff-line">完成：{view.latestHandoff.completed.join('；')}</p>}
        {view.latestHandoff.decisions.length > 0 && <p className="task-object-handoff-line">你当时的决定：{view.latestHandoff.decisions.map((decision) => decision.text).join('；')}</p>}
        {view.latestHandoff.unresolved.length > 0 && <p className="task-object-handoff-line">未决：{view.latestHandoff.unresolved.join('；')}</p>}
        {view.latestHandoff.next.length > 0 && <p className="task-object-handoff-line">下一步：{view.latestHandoff.next.join('；')}</p>}
        <p className="task-object-checkpoints">证据：文件 {view.latestHandoff.evidence.changes.length} · 命令 {view.latestHandoff.evidence.commands.length} · 作品 {view.latestHandoff.evidence.lifeWork.length}</p>
      </div>}
      <div className="card-actions task-object-actions">
        {view.status === 'proposed' && plan && (
          <button type="button" className="btn btn-primary btn-small" onClick={() => onApprove(view.id, plan.version)}>{words.approve}</button>
        )}
        {(view.status === 'active' || view.status === 'approved') && <>
          <button type="button" className="btn btn-primary btn-small" onClick={() => onClose(view.id, 'completed')}>{words.complete}</button>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => onClose(view.id, 'abandoned')}>{words.abandon}</button>
        </>}
      </div>
    </article>
  )
}

import type { AppBridge, AppSnapshot } from '../../../shared'
import words from '../voice/rewind.zh.json'
import { Notice } from './CommandControls'
import { fill } from './life/text'
import { useAct } from './useAct'

type Props = { snapshot: AppSnapshot; bridge: AppBridge }

/** 当前心流里的那次回退（心流结束就不再显示） */
const flowRewind = (snapshot: AppSnapshot) => snapshot.heartFlow?.activeId ? snapshot.heartFlow.rewind : undefined

/**
 * 从某一步往后回退（主进程先列出范围、核对版本，你确认后逐份写回并核实）。
 * 等你确认、正在回退：停在输入框上面。先把会回退哪几份文件、涉及几条改动、不撤回什么写清楚，再给确认按钮。
 */
export function RewindDock({ snapshot, bridge }: Props) {
  const view = flowRewind(snapshot)
  const act = useAct(bridge, snapshot, view?.id)
  if (!view || (view.status !== 'awaiting-confirmation' && view.status !== 'running')) return null
  const pending = view.status === 'awaiting-confirmation'
  return (
    <section className="dock-card dock-decision" data-rewind={view.status} role={pending ? 'alertdialog' : 'status'} aria-label={words.title}>
      <header className="dock-head">
        <span className="dock-label">{words.title}</span>
        {pending
          ? <span className="work-status">{words.status['awaiting-confirmation']}</span>
          : <span className="work-status" data-status="running">{fill(words.progress, { done: view.appliedFiles, total: view.paths.length })}<span className="work-pulse" aria-hidden /></span>}
      </header>
      <p className="work-lead">{fill(words.scopeLead, { files: view.paths.length, count: view.changeCount })}</p>
      <ul className="work-files">{view.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
      <p className="flow-note">{words.limit}</p>
      {view.error && <Notice>{words.errors[view.error]}</Notice>}
      <div className="card-actions dock-actions">
        {pending && <button type="button" className="btn btn-primary btn-small" disabled={act.busy} onClick={() => void act.send({ type: 'flow.rewind.apply', rewindId: view.id })}>{words.confirm}</button>}
        <button type="button" className="btn btn-ghost btn-small" disabled={act.busy} onClick={() => void act.send({ type: 'flow.rewind.cancel', rewindId: view.id })}>{words.cancel}</button>
        {act.busy && <span className="work-sending" role="status">{words.sending}</span>}
      </div>
      {act.failed && <Notice>{words.failed}</Notice>}
    </section>
  )
}

/** 回退结束后的结果，一行写在工作台“书桌上改过的文件”下面；没全部完成就用“！”提醒先检查文件 */
export function RewindResult({ snapshot }: { snapshot: AppSnapshot }) {
  const view = flowRewind(snapshot)
  if (!view || view.status === 'awaiting-confirmation' || view.status === 'running') return null
  const text = fill(words.result[view.status], { done: view.appliedFiles, total: view.paths.length })
  return (
    <div className="work-rewind-result" data-rewind={view.status}>
      {view.status === 'completed' || view.status === 'cancelled' ? <p className="work-facts">{text}</p> : <Notice>{text}</Notice>}
      {view.error && view.status !== 'completed' && <p className="flow-note">{words.errors[view.error]}</p>}
    </div>
  )
}

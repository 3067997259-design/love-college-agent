import { useState } from 'react'
import type { AppBridge, AppSnapshot, DelegateView, HeartFlowView } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { sendCommand, type CommandBody } from '../command'
import { fill } from '../life/text'
import './flow.css'

/**
 * 心流的工作视图（体验设计 §2：她进入心流时，右页换成工作视图——计划、命令与输出、改动、审批）。
 * 只用 heartFlow 快照：做到哪、改了什么、要不要批准都由主进程定；权限仍是“只在书桌、每次运行都问你”。
 * 审批卡单独放在输入框上面（FlowApproval），对话流滚到底时也不会被挤出视野。
 */
export function FlowPanel({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const flow = snapshot.heartFlow
  const [failed, setFailed] = useState(false)
  if (!flow?.activeId) return null
  const send = (body: CommandBody) => { void sendCommand(bridge, snapshot.epoch, body).then((result) => setFailed(!result.ok)) }
  const developer = snapshot.runtime?.developer.mode === 'developer'
  const delegates = (flow.delegates ?? []).filter((job) => job.flowId === flow.activeId)

  return (
    <section className="flow-panel" aria-label={copy.flow.title} data-mode={flow.mode}>
      <header className="flow-head">
        <span className="flow-title">{copy.flow.title}</span>
        <span className="flow-mode">{flow.mode === 'plan' ? copy.flow.plan : copy.flow.execute}</span>
        <span className="flow-scope">{flow.execution === 'disabled' ? copy.flow.boothOff : copy.flow.scope}</span>
      </header>
      <div className="flow-actions">
        <button type="button" className={`btn btn-small ${flow.mode === 'plan' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => send({ type: 'flow.mode', mode: flow.mode === 'plan' ? 'execute' : 'plan' })}>
          {flow.mode === 'plan' ? copy.flow.approvePlan : copy.flow.backToPlan}
        </button>
        <span className="flow-links">
          {(['status', 'permissions', 'diff'] as const).map((section) => (
            <button key={section} type="button" className="link-button" onClick={() => send({ type: 'flow.inspect', section })}>{copy.flow.inspect[section]}</button>
          ))}
          <button type="button" className="link-button" onClick={() => send({ type: 'flow.compact' })}>{copy.flow.compact}</button>
        </span>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => send({ type: 'flow.exit' })}>{copy.flow.exit}</button>
        {failed && <span className="notice-mark" title="没办成，稍后再试">！</span>}
      </div>

      {flow.lastRun && (
        <div className="flow-run" data-ok={flow.lastRun.ok}>
          <span className="flow-label">{flow.lastRun.ok ? copy.flow.lastOk : copy.flow.lastFailed}</span>
          <pre className="flow-code" aria-label="心流执行结果">{flow.lastRun.output}</pre>
        </div>
      )}

      {flow.changes.length > 0 && (
        <div className="flow-changes">
          <span className="flow-label">{copy.flow.changes}</span>
          <ul>
            {[...flow.changes].reverse().map((change) => (
              <li key={change.id} data-undone={change.undone}>
                <code>{change.path}</code>
                <small>{change.undone ? copy.flow.undone : copy.flow.kept}</small>
                {!change.undone && <button type="button" className="link-button" disabled={flow.mode === 'plan'} onClick={() => send({ type: 'flow.undo', changeId: change.id })}>{copy.flow.undo}</button>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {delegates.length > 0 && <Delegates jobs={delegates} onCancel={(id) => send({ type: 'flow.delegate.cancel', delegateId: id })} />}
      {developer && <DevRun flow={flow} onRun={(code) => send({ type: 'flow.run', code })} />}
    </section>
  )
}

/** 待批准的那一段代码：贴在输入框上面，批准只管这一次（技术方案 §3.11） */
export function FlowApproval({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const pending = snapshot.heartFlow?.activeId ? snapshot.heartFlow.pending : undefined
  if (!pending) return null
  const decide = (allow: boolean) => { void sendCommand(bridge, snapshot.epoch, { type: 'flow.approve', approvalId: pending.id, allow }) }
  return (
    <div className="flow-approval" role="alertdialog" aria-label="本次脚本审批">
      <span className="flow-label">{copy.flow.askRun}</span>
      <pre className="flow-code">{pending.code}</pre>
      <p className="flow-note">{copy.flow.sandbox}</p>
      <div className="card-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={() => decide(true)}>{copy.flow.allowOnce}</button>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => decide(false)}>{copy.flow.deny}</button>
      </div>
    </div>
  )
}

/** 分身的活动卡：纸飞机出去查，查完飞回来交给她核对；只有元数据（技术方案 §3.12） */
function Delegates({ jobs, onCancel }: { jobs: readonly DelegateView[]; onCancel: (id: string) => void }) {
  return (
    <div className="flow-delegates">
      <span className="flow-label">{copy.flow.delegates}</span>
      <ul>
        {jobs.map((job, index) => (
          <li key={job.id} className="delegate-card" data-status={job.status}>
            <PaperPlane />
            <span className="delegate-name">{copy.flow.delegates} {index + 1}</span>
            <span className="delegate-state">
              {job.status === 'running' ? fill(copy.flow.delegate.running, { n: job.sourceCount }) : copy.flow.delegate[job.status]}
              {job.error && job.status !== 'cancelled' && ` · ${copy.flow.delegateError[job.error]}`}
              {job.source === 'fake' && <small className="demo-tag">{copy.shelf.fake}</small>}
            </span>
            {job.status === 'running' && <button type="button" className="link-button" onClick={() => onCancel(job.id)}>{copy.flow.cancelDelegate}</button>}
          </li>
        ))}
      </ul>
      <p className="flow-note">{copy.flow.delegateNote}</p>
    </div>
  )
}

function PaperPlane() {
  return (
    <svg className="paper-plane" viewBox="0 0 28 20" aria-hidden>
      <path className="plane-trail" d="M1 17 Q 7 15, 11 12" fill="none" stroke="var(--pencil)" strokeWidth="1" strokeDasharray="2 2.5" strokeLinecap="round" />
      <path d="M10 11 L27 2 L18 18 L15.5 12.5 Z" fill="var(--paper)" stroke="#4d3f45" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M15.5 12.5 L27 2" fill="none" stroke="#4d3f45" strokeWidth="0.8" />
    </svg>
  )
}

/** 开发者模式下自己写一段让她申请运行（Electron 场景用它）；平时由她用工具提出，你只负责批准 */
function DevRun({ flow, onRun }: { flow: HeartFlowView; onRun: (code: string) => void }) {
  const [code, setCode] = useState('return 6 * 7')
  return (
    <div className="flow-dev">
      <span className="flow-label">{copy.flow.devRun}</span>
      <textarea className="flow-code" aria-label={copy.flow.devCode} value={code} maxLength={10000} rows={2} onChange={(event) => setCode(event.target.value)} />
      <button type="button" className="btn btn-ghost btn-small" disabled={flow.execution === 'disabled' || flow.mode === 'plan' || !!flow.pending} onClick={() => onRun(code)}>{copy.flow.devSubmit}</button>
    </div>
  )
}

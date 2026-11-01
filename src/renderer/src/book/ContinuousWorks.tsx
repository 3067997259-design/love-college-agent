import { useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import type { WorkStatus } from '../../../shared/continuity'
import { sendCommand, type CommandBody } from './command'

const status: Record<WorkStatus, string> = { queued: '排队中', running: '正在做', waiting: '等你回应', paused: '已暂停', stopping: '正在停止', stopped: '已停止', review_required: '需要核对后继续', completed: '已交付', failed: '这次没做完' }

/** Existing conversation dock: safe task cards, never the worker's raw transcript. */
export function ContinuousWorks({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const [error, setError] = useState(false)
  const view = snapshot.continuousWorks
  if (!view || !view.items.length && !view.failure) return null
  const send = async (body: CommandBody) => { const ack = await sendCommand(bridge, snapshot.epoch, body); setError(!ack.ok) }
  return <details className="continuous-works">
    <summary>手上的工作{view.active > 0 ? ` · ${view.active} 项进行中` : ''}</summary>
    {view.failure && <p role="status">工作记录暂时无法读取，请保留数据后重新打开。</p>}
    <ul>{view.items.map(work => {
      const target = { identity: work.identity, expectedRevision: work.revision }
      return <li key={work.identity.workId}>
        <p>{work.label}</p><small>{status[work.status]}{work.waitingFor === 'approval' ? ' · 等你批准' : ''}</small>
        <div>{work.controls.resume && <button type="button" onClick={() => { void send({ type: 'work.resume', target }) }}>核对并继续</button>}
          {work.controls.pause && <button type="button" onClick={() => { void send({ type: 'work.pause', target }) }}>暂停</button>}
          {work.controls.stop && <button type="button" onClick={() => { void send({ type: 'work.stop', target }) }}>停止</button>}</div>
      </li>
    })}</ul>
    {error && <p role="status">工作状态已变化，请按最新状态再操作。</p>}
  </details>
}

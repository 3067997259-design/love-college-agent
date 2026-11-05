import { useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import type { WorkStatus } from '../../../shared/continuity'
import { sendCommand, type CommandBody } from './command'

const status: Record<WorkStatus, string> = { queued: '排队中', running: '正在做', waiting: '等你回应', paused: '已暂停', stopping: '正在停止', stopped: '已停止', review_required: '需要核对后继续', completed: '已完成', failed: '这次没做完' }

/**
 * 右页输入框上方的「手上的工作」：后台持久工作车道的安全投影。
 * 排版按书里的纸片来（暖白纸、细铅笔边、手写标题），状态用中性小徽章，
 * 不展示 worker 的原始会话，也不把「已请求」说成「已完成」。
 */
export function ContinuousWorks({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const [error, setError] = useState(false)
  const view = snapshot.continuousWorks
  if (!view || !view.items.length && !view.failure) return null
  const send = async (body: CommandBody) => { const ack = await sendCommand(bridge, snapshot.epoch, body); setError(!ack.ok) }
  return <details className="continuous-works">
    <summary>
      <span className="cw-title">手上的工作</span>
      {view.active > 0 && <span className="cw-badge" data-tone="active">{view.active} 项进行中</span>}
      {view.active === 0 && <span className="cw-count">{view.items.length} 件</span>}
    </summary>
    {view.failure && <p className="cw-note" role="status">工作记录暂时无法读取，请保留数据后重新打开。</p>}
    <ul className="cw-list">{view.items.map(work => {
      const target = { identity: work.identity, expectedRevision: work.revision }
      return <li key={work.identity.workId} className="cw-item" data-status={work.status}>
        <div className="cw-item-head">
          <strong className="cw-label">{work.label}</strong>
          <span className="cw-badge" data-tone={work.status === 'completed' ? 'done' : work.status === 'failed' ? 'failed' : 'plain'}>
            {status[work.status]}{work.waitingFor === 'approval' ? ' · 等你批准' : ''}
          </span>
        </div>
        {work.result?.interruption && work.result.completion === 'unverified' && <p className="cw-note">执行曾被中断，结果待核对。停止不代表外部动作已撤回。</p>}
        {!!work.progress?.observedActions && <p className="cw-note cw-progress">已改动 {work.progress.changedFiles} 个文件 · 命令通过 {work.progress.completedCommands} 项{work.progress.failedActions ? ` · ${work.progress.failedActions} 次失败` : ''}</p>}
        <div className="cw-actions">{work.controls.resume && <button type="button" onClick={() => { void send({ type: 'work.resume', target }) }}>核对并继续</button>}
          {work.controls.pause && <button type="button" onClick={() => { void send({ type: 'work.pause', target }) }}>暂停</button>}
          {work.controls.stop && <button type="button" onClick={() => { void send({ type: 'work.stop', target }) }}>停止</button>}</div>
      </li>
    })}</ul>
    {error && <p className="cw-note" role="status">工作状态已变化，请按最新状态再操作。</p>}
  </details>
}

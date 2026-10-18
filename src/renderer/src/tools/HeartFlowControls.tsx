import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
import copy from '../voice/book.zh.json'
import { ComputerControls } from './ComputerControls'
import { WebFetchControls } from './WebFetchControls'
export function HeartFlowControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [code, setCode] = useState('return 6 * 7'); const [goalText, setGoalText] = useState(''); const [error, setError] = useState(''); const flow = snapshot.heartFlow
  if (!flow) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  const currentGoal = flow.goals?.find((goal) => goal.id === flow.goalId)
  return <section className="flow-work" aria-label="书桌心流"><h2>书桌心流</h2>
    <p>仅她的书桌 · JavaScript 沙箱 · 每次运行都审批 · {flow.mode === 'plan' ? '只读计划' : '可写执行'}</p>
    {!flow.activeId ? <button onClick={() => void send({ type: 'flow.enter' })}>进入心流</button> : <>
      <button onClick={() => void send({ type: 'flow.mode', mode: flow.mode === 'plan' ? 'execute' : 'plan' })}>{flow.mode === 'plan' ? '批准计划并允许书桌写入' : '回到只读计划'}</button>
      <button onClick={() => void send({ type: 'flow.compact' })}>收起工作过程</button><button onClick={() => void send({ type: 'flow.exit' })}>退出心流</button>
      <button onClick={() => void send({ type: 'flow.inspect', section: 'status' })}>心流状态</button><button onClick={() => void send({ type: 'flow.inspect', section: 'permissions' })}>心流权限</button><button onClick={() => void send({ type: 'flow.inspect', section: 'diff' })}>查看本次差异</button>
      <button disabled={flow.mode !== 'execute' || snapshot.task?.status === 'running'} onClick={() => void send({ type: 'flow.init' })}>生成项目说明草稿</button>
      <button disabled={flow.mode !== 'execute' || snapshot.task?.status === 'running'} onClick={() => void send({ type: 'flow.review' })}>审查本次改动草稿</button>
      <label>申请运行 JavaScript<textarea aria-label="心流 JavaScript" value={code} maxLength={10000} onChange={(event) => setCode(event.target.value)} /></label>
      <button disabled={flow.execution === 'disabled' || flow.mode === 'plan' || !!flow.pending} onClick={() => void send({ type: 'flow.run', code })}>申请执行</button>
      {flow.pending && <div role="alertdialog" aria-label="本次脚本审批"><pre>{flow.pending.code}</pre><p>无 Node、网络、系统文件、应用接口；最多 5 秒。</p>
        <button onClick={() => void send({ type: 'flow.approve', approvalId: flow.pending!.id, allow: true })}>仅批准这一次</button><button onClick={() => void send({ type: 'flow.approve', approvalId: flow.pending!.id, allow: false })}>拒绝这一次</button></div>}
      {flow.lastRun && <pre aria-label="心流执行结果">{flow.lastRun.output}</pre>}
      <ul>{flow.changes.map((change) => <li key={change.id}>{change.path} · {change.undone ? '已撤回' : '已留快照'}<button disabled={change.undone || flow.mode === 'plan'} onClick={() => void send({ type: 'flow.undo', changeId: change.id })}>撤回此版本</button></li>)}</ul>
      {!!flow.delegates?.length && <section aria-label="只读分身"><h3>只读分身</h3><ul>{flow.delegates.map((job) => <li key={job.id}>{job.id.slice(0, 8)} · {job.status} · {job.sourceCount} 份来源 · {job.source}{job.error ? ' · ' + job.error : ''}{job.status === 'running' && <button onClick={() => void send({ type: 'flow.delegate.cancel', delegateId: job.id })}>取消这个分身</button>}</li>)}</ul><p>结论先交回本体核对，分身不写文件或记忆。</p></section>}
    </>}
    <ComputerControls bridge={bridge} snapshot={snapshot} />
    <WebFetchControls bridge={bridge} snapshot={snapshot} />
    <p>{flow.files.length} 个书桌文件 · {flow.sessions.length} 次心流</p>{error && <p role="alert">{error}</p>}
    {!!flow.operations?.length && <section aria-label="项目说明与审查草稿"><h3>工作草稿</h3><p>草稿已落盘不表示审查通过或测试通过。</p><ul>{flow.operations.map((op) => <li key={op.id} data-operation-id={op.id}>{op.kind === 'init' ? '项目说明' : '改动审查'} · {op.status} · {op.source} · {op.sourceCount} 份来源{op.omittedSourceCount > 0 && ` · ${op.omittedSourceCount} 份未纳入`}{op.error && ` · ${op.error}`}
      {op.artifact && <button onClick={() => void send({ type: 'flow.operation.open', operationId: op.id })}>查阅工作草稿</button>}</li>)}</ul></section>}
    <section aria-label="跨次工作目标"><h3>工作目标</h3><p>跨次保留；目标状态由你标记，文件和运行结果另有实际记录。</p>
      <label>工作长期目标<input aria-label="工作长期目标" value={goalText} maxLength={200} onChange={(event) => setGoalText(event.target.value)} /></label>
      <button disabled={!goalText.trim()} onClick={() => void send({ type: 'flow.goal.set', text: goalText })}>新建工作目标</button>
      {currentGoal && <div className="flow-current-goal" data-goal-id={currentGoal.id}>
        <span>{currentGoal.text} · {currentGoal.status === 'active' ? '进行中' : currentGoal.status === 'completed' ? '用户标记完成' : '用户取消'} · {currentGoal.flowIds.length} 次心流</span>
        <button disabled={currentGoal.status === 'completed'} onClick={() => void send({ type: 'flow.goal.status', goalId: currentGoal.id, status: 'completed' })}>标记目标完成</button>
      </div>}
      {!!flow.goals?.length && <details className="flow-goals-manage"><summary>{copy.flow.goalManage}</summary>
        <button disabled={!goalText.trim() || !flow.goalId} onClick={() => void send({ type: 'flow.goal.set', goalId: flow.goalId!, text: goalText })}>更新所选目标</button>
        <ul>{(flow.goals ?? []).map((goal) => <li key={goal.id}>{goal.text} · {goal.status === 'active' ? '进行中' : goal.status === 'completed' ? '用户标记完成' : '用户取消'} · {goal.flowIds.length} 次心流{flow.goalId === goal.id && ' · 当前所选'}
          <button disabled={goal.status !== 'active'} onClick={() => { setGoalText(goal.text); void send({ type: 'flow.goal.select', goalId: goal.id }) }}>选为工作目标</button>
          <button disabled={goal.status === 'cancelled'} onClick={() => void send({ type: 'flow.goal.status', goalId: goal.id, status: 'cancelled' })}>取消这个目标</button>
          <button disabled={goal.status === 'active'} onClick={() => void send({ type: 'flow.goal.status', goalId: goal.id, status: 'active' })}>重新打开目标</button>
        </li>)}</ul>
      </details>}
    </section>
    <details><summary>历次心流</summary><ol>{flow.sessions.map((session) => <li key={session.id}>{session.id.slice(0, 8)} · {session.endedAtMs === null ? '进行中' : '已结束'}
      <button onClick={() => void send({ type: 'flow.inspect', section: 'status', flowId: session.id })}>查阅状态</button><button onClick={() => void send({ type: 'flow.inspect', section: 'diff', flowId: session.id })}>查阅差异</button>
      <button disabled={!!flow.activeId || session.endedAtMs === null} onClick={() => void send({ type: 'flow.resume', flowId: session.id })}>接着做这次心流</button>
    </li>)}</ol></details>
  </section>
}

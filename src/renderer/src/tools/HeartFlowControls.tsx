import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
export function HeartFlowControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [code, setCode] = useState('return 6 * 7'); const [error, setError] = useState(''); const flow = snapshot.heartFlow
  if (!flow) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  return <section className="flow-work" aria-label="书桌心流"><h2>书桌心流</h2>
    <p>仅她的书桌 · JavaScript 沙箱 · 每次运行都审批 · {flow.mode === 'plan' ? '只读计划' : '可写执行'}</p>
    {!flow.activeId ? <button onClick={() => void send({ type: 'flow.enter' })}>进入心流</button> : <>
      <button onClick={() => void send({ type: 'flow.mode', mode: flow.mode === 'plan' ? 'execute' : 'plan' })}>{flow.mode === 'plan' ? '批准计划并允许书桌写入' : '回到只读计划'}</button>
      <button onClick={() => void send({ type: 'flow.compact' })}>收起工作过程</button><button onClick={() => void send({ type: 'flow.exit' })}>退出心流</button>
      <button onClick={() => void send({ type: 'flow.inspect', section: 'status' })}>心流状态</button><button onClick={() => void send({ type: 'flow.inspect', section: 'permissions' })}>心流权限</button><button onClick={() => void send({ type: 'flow.inspect', section: 'diff' })}>查看本次差异</button>
      <label>申请运行 JavaScript<textarea aria-label="心流 JavaScript" value={code} maxLength={10000} onChange={(event) => setCode(event.target.value)} /></label>
      <button disabled={flow.execution === 'disabled' || flow.mode === 'plan' || !!flow.pending} onClick={() => void send({ type: 'flow.run', code })}>申请执行</button>
      {flow.pending && <div role="alertdialog" aria-label="本次脚本审批"><pre>{flow.pending.code}</pre><p>无 Node、网络、系统文件、应用接口；最多 5 秒。</p>
        <button onClick={() => void send({ type: 'flow.approve', approvalId: flow.pending!.id, allow: true })}>仅批准这一次</button><button onClick={() => void send({ type: 'flow.approve', approvalId: flow.pending!.id, allow: false })}>拒绝这一次</button></div>}
      {flow.lastRun && <pre aria-label="心流执行结果">{flow.lastRun.output}</pre>}
      <ul>{flow.changes.map((change) => <li key={change.id}>{change.path} · {change.undone ? '已撤回' : '已留快照'}<button disabled={change.undone || flow.mode === 'plan'} onClick={() => void send({ type: 'flow.undo', changeId: change.id })}>撤回此版本</button></li>)}</ul>
      {!!flow.delegates?.length && <section aria-label="只读分身"><h3>只读分身</h3><ul>{flow.delegates.map((job) => <li key={job.id}>{job.id.slice(0, 8)} · {job.status} · {job.sourceCount} 份来源 · {job.source}{job.error ? ' · ' + job.error : ''}{job.status === 'running' && <button onClick={() => void send({ type: 'flow.delegate.cancel', delegateId: job.id })}>取消这个分身</button>}</li>)}</ul><p>结论先交回本体核对，分身不写文件或记忆。</p></section>}
    </>}
    <p>{flow.files.length} 个书桌文件 · {flow.sessions.length} 次心流</p>{error && <p role="alert">{error}</p>}
    <details><summary>历次心流</summary><ol>{flow.sessions.map((session) => <li key={session.id}>{session.id.slice(0, 8)} · {session.endedAtMs === null ? '进行中' : '已结束'}
      <button onClick={() => void send({ type: 'flow.inspect', section: 'status', flowId: session.id })}>查阅状态</button><button onClick={() => void send({ type: 'flow.inspect', section: 'diff', flowId: session.id })}>查阅差异</button>
      <button disabled={!!flow.activeId || session.endedAtMs === null} onClick={() => void send({ type: 'flow.resume', flowId: session.id })}>接着做这次心流</button>
    </li>)}</ol></details>
  </section>
}

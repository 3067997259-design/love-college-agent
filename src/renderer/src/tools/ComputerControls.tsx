import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
export function ComputerControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const computer = snapshot.heartFlow?.computer; if (!computer) return null
  const send = (body: object) => bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand)
  return <section aria-label="隔离书桌预览"><h3>书桌静态预览</h3><p>页面脚本和网络已关闭，只操作此预览；每个动作需你确认。</p>
    {(snapshot.heartFlow?.files ?? []).filter((file) => /\.html?$/i.test(file.path)).map((file) => <button key={file.path} disabled={snapshot.heartFlow?.mode !== 'execute' || snapshot.task?.status === 'running' || snapshot.heartFlow.execution === 'disabled'} onClick={() => void send({ type: 'flow.computer.open', path: file.path })}>预览 {file.path}</button>)}
    <p>{computer.status} · {computer.actionsUsed}/{computer.maxActions} 次动作</p>
    {computer.status !== 'closed' && <button onClick={() => void send({ type: 'flow.computer.close' })}>关闭书桌预览</button>}
    {computer.pending && <div role="alertdialog" aria-label="书桌预览动作审批"><p>{computer.target?.path} · {JSON.stringify(computer.pending.action)}</p><p>只对当前页面这一个动作有效。</p>
      <button onClick={() => void send({ type: 'flow.computer.approve', approvalId: computer.pending!.id, allow: true })}>仅批准这个预览动作</button><button onClick={() => void send({ type: 'flow.computer.approve', approvalId: computer.pending!.id, allow: false })}>拒绝这个预览动作</button></div>}
    {computer.error && <p role="status">预览操作未完成：{computer.error.code}</p>}
  </section>
}

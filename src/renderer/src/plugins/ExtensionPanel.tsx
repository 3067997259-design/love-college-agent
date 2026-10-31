import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot, ExtensionOperation } from '../../../shared'
import { sendCommand, type CommandBody } from '../book/command'
import { SettingsIssue } from '../tools/SettingsIssue'

const actionLabel = { install: '安装', enable: '启用', disable: '停用', remove: '移除', restart: '重启', reconcile: '核对' }
export function operationLabel(operation: ExtensionOperation): string {
  if (operation.outcome === 'unknown') return '结果未知，请核对后再操作'
  if (operation.outcome === 'failed') return operation.pendingBuilds?.length ? '构建脚本需要单独批准' : '未完成'
  if (operation.outcome === 'cancelled') return '已取消'
  if (operation.outcome === 'succeeded') return '已完成'
  return { preparing: '准备中', 'awaiting-approval': '等待你批准', running: '进行中', cancelling: '正在取消并核对', reconciling: '正在核对', settled: '等待回执' }[operation.phase]
}

export function ExtensionPanel({ snapshot, bridge, search }: { snapshot: AppSnapshot; bridge: AppBridge; search: string }) {
  const view = snapshot.extensions
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  const refreshed = useRef('')
  const skillBusy = snapshot.skills?.status === 'loading'
  useEffect(() => {
    if (skillBusy || refreshed.current === snapshot.epoch) return
    refreshed.current = snapshot.epoch
    if (view?.status === 'ready') return
    void sendCommand(bridge, snapshot.epoch, { type: 'extension.refresh' }).then((result) => { if (!result.ok) setError(result.code) })
  }, [bridge, snapshot.epoch, skillBusy, view?.status])
  const send = async (body: CommandBody) => {
    setPending(true); setError('')
    const result = await sendCommand(bridge, snapshot.epoch, body)
    setPending(false); if (!result.ok) setError(result.code)
  }
  if (!view) return <p className="plugin-empty">扩展运行时暂不可用。</p>
  const active = view.operations.some((op) => op.outcome === 'pending')
  const uncertain = view.operations.some((op) => op.outcome === 'unknown')
  const busy = pending || active || view.status === 'reconciling' || snapshot.skills?.status === 'loading'
  const items = view.items.filter((item) => !search.trim() || item.name.toLowerCase().includes(search.trim().toLowerCase()))
  const shownOperations = view.operations.filter((op, index) => index >= view.operations.length - 4 || op.outcome === 'unknown' || op.outcome === 'pending').slice().reverse()
  const proposal = view.proposal
  return <section className="extension-panel" aria-label="DSH 扩展管理">
    <div className="plugin-section-head"><h3 className="plugin-section">DSH 扩展</h3>
      <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void send({ type: 'extension.refresh' })}>刷新扩展</button>
      <button type="button" className="btn btn-small btn-ghost" disabled={busy || uncertain} onClick={() => void send({ type: 'extension.pick' })}>添加 DSH 扩展</button>
    </div>
    <p className="plugin-meta">本地 bundle · 此存档共用 · 安装后默认停用</p>
    {view.status !== 'ready' && <p className="plugin-notice" role="status">{view.status === 'reconciling' ? '正在核对扩展状态……' : view.status === 'failed' ? '读取或操作失败，可以刷新核对。' : '尚未连接扩展运行时，刷新后核对实际状态。'}</p>}
    {view.items.some((item) => item.restartReason) && <p className="plugin-notice" role="status">设置已保存，重启扩展后生效。</p>}
    <button type="button" className="btn btn-small btn-ghost" disabled={busy || uncertain} onClick={() => void send({ type: 'extension.restart' })}>重启扩展运行时</button>
    {proposal && !view.items.some((item) => item.name === proposal.name && item.installation === 'installed') && <div className="plugin-approval" aria-label="待安装扩展">
      <strong>{proposal.name} {proposal.version}</strong><p>{proposal.sourceLabel} · 此存档</p>
      <details className="plugin-details"><summary>来源指纹</summary><code>{proposal.fingerprint}</code></details>
      <button type="button" className="btn btn-small btn-primary" disabled={busy || uncertain} onClick={() => void send({ type: 'extension.install', proposalId: proposal.id, fingerprint: proposal.fingerprint })}>申请安装</button>
    </div>}
    {[false, true].map((protectedGroup) => {
      const rows = items.filter((item) => item.protected === protectedGroup).map((item) => <li className="plugin-row extension-row" key={item.id} data-extension-id={item.id}>
        <details>
          <summary><strong>{item.name}</strong><span className="plugin-meta">{item.protected ? '受保护 · ' : ''}{item.restartReason ? '待重启' : { ready: '已生效', disabled: '已停用', failed: '加载失败', unknown: '状态待核对' }[item.applied]}</span></summary>
          <div className="plugin-config">
            <p className="plugin-meta">{item.version ?? '未提供版本'} · {item.source.label} · 此存档</p>
            <p className="plugin-meta">已保存：{item.enabledIntent ? '启用' : '停用'}；当前运行：{{ ready: '已加载', disabled: '未加载', failed: '加载失败', unknown: '未知' }[item.applied]}</p>
            <details className="plugin-details"><summary>来源指纹</summary><code>{item.source.fingerprint}</code></details>
            {item.protected ? <p className="plugin-meta">随应用维护，不能在这里停用或移除。</p> : <div className="card-actions">
              <button type="button" className="btn btn-small btn-ghost" disabled={busy || uncertain || view.status !== 'ready'} onClick={() => void send({ type: item.enabledIntent ? 'extension.disable' : 'extension.enable', extensionId: item.id, expectedRevision: item.revision, fingerprint: item.source.fingerprint })}>{item.enabledIntent ? '停用' : '启用'}</button>
              <button type="button" className="btn btn-small btn-ghost" disabled={busy || uncertain || view.status !== 'ready' || item.enabledIntent || item.applied !== 'disabled'} onClick={() => void send({ type: 'extension.remove', extensionId: item.id, expectedRevision: item.revision, fingerprint: item.source.fingerprint })}>移除</button>
              {(item.enabledIntent || item.applied !== 'disabled') && <p className="plugin-meta">先停用并重启，再移除。</p>}
            </div>}
            <SettingsIssue code={item.error?.code} />
          </div>
        </details>
      </li>)
      return protectedGroup ? <details className="extension-core" key="core"><summary>随应用维护的组件 · {rows.length}</summary><ul className="plugin-list">{rows}</ul></details> : <ul className="plugin-list" key="installed">{rows}</ul>
    })}
    {!items.length && view.status === 'ready' && <p className="plugin-empty">{search ? '没有匹配的 DSH 扩展。' : '暂无 DSH 扩展。'}</p>}
    {!!shownOperations.length && <details className="extension-history" open={active || uncertain || undefined}>
      <summary>最近的扩展操作</summary>
      <ul className="plugin-list">{shownOperations.map((op) => <li className="extension-operation" key={op.id} data-operation={op.id} data-outcome={op.outcome}>
        <p><strong>{actionLabel[op.action]} {op.extensionId ?? '扩展运行时'}</strong></p>
        <p className="plugin-meta" role="status">{operationLabel(op)}</p>
        {!!op.pendingBuilds?.length && <p className="plugin-meta">构建脚本：{op.pendingBuilds.join('、')}</p>}
        {op.cancellable && op.outcome === 'pending' && <button type="button" className="btn btn-small btn-ghost" disabled={pending || op.phase === 'cancelling'} onClick={() => void send({ type: 'extension.cancel', operationId: op.id, expectedRevision: op.revision })}>取消操作</button>}
        {op.outcome === 'unknown' && <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void send({ type: 'extension.reconcile', operationId: op.id, expectedRevision: op.revision })}>核对这次操作</button>}
        {op.outcome === 'failed' && !op.pendingBuilds?.length && <SettingsIssue code={op.error?.code} />}
      </li>)}</ul>
      <p className="plugin-meta">取消会等待状态核对；已发生的操作不一定能撤回。</p>
    </details>}
    <SettingsIssue code={error} />
  </section>
}

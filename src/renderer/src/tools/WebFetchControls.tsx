import type { AppBridge, AppSnapshot } from '../../../shared'
export function WebFetchControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const view = snapshot.heartFlow?.webFetch; if (!view) return null
  const decide = (allow: boolean) => view.pending && bridge.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'flow.fetch.approve', approvalId: view.pending.id, allow })
  return <section aria-label="公共网页读取"><h3>网页读取</h3><p>{view.source === 'fake' ? '合成网页' : '公共 HTTPS'} · {view.status} · {view.requestsUsed}/{view.maxRequests}</p>
    {view.pending && <div role="alertdialog" aria-label="网页读取审批"><p>向这个确切地址发一次 GET：</p><code>{view.pending.url}</code><p>不带凭据、不跟重定向；返回内容仅用于当前工作。</p><button onClick={() => void decide(true)}>仅读取这个地址一次</button><button onClick={() => void decide(false)}>拒绝这个地址</button></div>}
    {view.last && <p>{view.last.status} · {view.last.receivedBytes ?? '—'} 字节{view.last.truncated && ' · 只读取了开头部分'}</p>}
  </section>
}

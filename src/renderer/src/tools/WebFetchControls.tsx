import type { AppBridge, AppSnapshot } from '../../../shared'
import copy from '../voice/book.zh.json'
import { fill } from '../book/life/text'

const words = copy.deskTools

export function WebFetchControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const view = snapshot.heartFlow?.webFetch; if (!view) return null
  const decide = (allow: boolean) => view.pending && bridge.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'flow.fetch.approve', approvalId: view.pending.id, allow })
  return <section aria-label="公共网页读取"><h3>网页读取</h3><p>{words.fetchSource[view.source]} · {words.fetchStatus[view.status]} · {fill(words.fetchUsage, { used: view.requestsUsed, max: view.maxRequests })}</p>
    {view.pending && <div role="alertdialog" aria-label="网页读取审批"><p>向这个确切地址发一次 GET：</p><code>{view.pending.url}</code><p>不带凭据、不跟重定向；返回内容仅用于当前工作。</p><button onClick={() => void decide(true)}>仅读取这个地址一次</button><button onClick={() => void decide(false)}>拒绝这个地址</button></div>}
    {view.last && <p>{fill(words.fetchLast[view.last.status], { bytes: view.last.receivedBytes ?? '—' })}{view.last.truncated && ` · ${words.fetchTruncated}`}</p>}
  </section>
}

import { useEffect, useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, OpticalMemoryRead, OpticalTier } from '../../../shared'
export function OpticalControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const view = snapshot.opticalMemory; const [error, setError] = useState(''); const [read, setRead] = useState<OpticalMemoryRead | null>(null)
  useEffect(() => { setRead(null) }, [snapshot.epoch])
  if (!view) return null
  const send = async (body: Record<string, unknown>) => { try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') } catch { setError('connection-failed') } }
  const open = async (id: string) => { try { if (bridge.readOpticalMemory) setRead(await bridge.readOpticalMemory(id)) } catch { setError('unavailable') } }
  const pages = snapshot.session?.pages.filter((page) => page.sessionId !== snapshot.scope.sessionId) ?? []
  return <section aria-label="光学记忆实验"><h2>光学记忆（可选实验）</h2>
    <p>{view.source} · {view.status} · 文字记忆继续可用。OCR 印象不作事实；具体细节回查原文。</p>
    <button disabled={view.status === 'processing'} onClick={() => void send({ type: 'optical.configure' })}>导入光学服务配置</button>
    <label><input type="checkbox" checked={view.enabled} onChange={(event) => void send({ type: 'optical.enable', enabled: event.target.checked })} />启用光学印象</label>
    <ul>{pages.map((page) => <li key={page.sessionId}>{page.dayKey}<button disabled={!view.enabled || view.status === 'processing'} onClick={() => void send({ type: 'optical.encode', sessionId: page.sessionId })}>封存此页（每次最多四张）</button></li>)}</ul>
    <ul>{view.frames.map((frame) => <li key={frame.id}>{frame.sessionId.slice(0, 8)} · {frame.pageIndex + 1}/{frame.pageCount} · {frame.sourceCount} 段来源
      <button disabled={!bridge.readOpticalMemory} onClick={() => void open(frame.id)}>查阅光学页</button>
      {(['large', 'base', 'small', 'tiny'] as const).map((tier: OpticalTier) => <button key={tier} disabled={!view.enabled || view.source === 'none' || view.status === 'processing'} onClick={() => void send({ type: 'optical.decode', frameId: frame.id, tier })}>{tier} 解码</button>)}
      <ul>{view.impressions.filter((entry) => entry.frameId === frame.id).map((entry) => <li key={entry.tier}>{entry.tier} · {entry.status} · 保留 {entry.verifiedLineCount} 行／拒绝 {entry.rejectedLineCount} 行</li>)}</ul>
    </li>)}</ul>
    {read && <article aria-label="用户光学页"><button onClick={() => setRead(null)}>关闭光学页</button><img src={read.imageUrl} alt="当时可见对话的独立印刷页" style={{ width: '100%', maxWidth: 640 }} /><p>未经审核、可能不完整的印象。看不清的细节保持未知。</p>{read.impressions.map((entry) => <div key={entry.tier}><strong>{entry.tier} · {entry.status}</strong><pre>{entry.fragments.join('\n')}</pre></div>)}</article>}
    {error && <p role="alert">{error}</p>}
  </section>
}

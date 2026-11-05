import { useEffect, useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, OpticalMemoryRead, OpticalTier } from '../../../shared'
import book from '../voice/book.zh.json'
import { dayKeyLabel } from '../book/life/text'
import { SettingsIssue } from './SettingsIssue'

const TIERS = book.history.impression.tiers
const STATE = { idle: '', processing: '正在处理', failed: '上次没做完', unconfigured: '还没配置光学服务' } as const

/** 光学记忆实验：把旧页印成图片，再让模型凭图片读回来。设置页把它放在“光学记忆实验”组里，组名就是标题。 */
export function OpticalControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const view = snapshot.opticalMemory; const [error, setError] = useState(''); const [read, setRead] = useState<OpticalMemoryRead | null>(null)
  useEffect(() => { setRead(null) }, [snapshot.epoch])
  if (!view) return null
  const send = async (body: Record<string, unknown>) => { try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') } catch { setError('connection-failed') } }
  const open = async (id: string) => { try { if (bridge.readOpticalMemory) setRead(await bridge.readOpticalMemory(id)) } catch { setError('unavailable') } }
  const pages = snapshot.session?.pages.filter((page) => page.sessionId !== snapshot.scope.sessionId) ?? []
  const state = [view.source === 'fake' ? '合成服务（开发场景）' : '', STATE[view.status]].filter(Boolean).join(' · ')
  return <section aria-label="光学记忆实验">
    <p className="settings-note">把以前的日页印成图片，再让模型看着图片回想。只是实验：读回来的印象可能不全，细节要看原话。文字记忆照常用。</p>
    {state && <p>{state}</p>}
    <div className="settings-actions"><button disabled={view.status === 'processing'} onClick={() => void send({ type: 'optical.configure' })}>导入光学服务配置</button></div>
    <label><input type="checkbox" checked={view.enabled} onChange={(event) => void send({ type: 'optical.enable', enabled: event.target.checked })} />启用光学印象</label>
    {pages.length > 0 && <ul>{pages.map((page) => <li key={page.sessionId}>{dayKeyLabel(page.dayKey)} <button disabled={!view.enabled || view.status === 'processing'} onClick={() => void send({ type: 'optical.encode', sessionId: page.sessionId })}>封存此页（每次最多四张）</button></li>)}</ul>}
    {view.frames.length > 0 && <ul>{view.frames.map((frame) => <li key={frame.id}>第 {frame.pageIndex + 1}/{frame.pageCount} 张 · {frame.sourceCount} 段原话
      <div className="settings-actions">
        <button disabled={!bridge.readOpticalMemory} onClick={() => void open(frame.id)}>查阅光学页</button>
        {(['large', 'base', 'small', 'tiny'] as const).map((tier: OpticalTier) => <button key={tier} disabled={!view.enabled || view.source === 'none' || view.status === 'processing'} onClick={() => void send({ type: 'optical.decode', frameId: frame.id, tier })}>按{TIERS[tier]}读回</button>)}
      </div>
      <ul>{view.impressions.filter((entry) => entry.frameId === frame.id).map((entry) => <li key={entry.tier}>{TIERS[entry.tier]} · {entry.status === 'guarded' ? '读回来了' : '没采用'} · 对上原话 {entry.verifiedLineCount} 行，对不上 {entry.rejectedLineCount} 行</li>)}</ul>
    </li>)}</ul>}
    {read && <article aria-label="用户光学页"><button onClick={() => setRead(null)}>关闭光学页</button><img src={read.imageUrl} alt="当时可见对话的独立印刷页" style={{ width: '100%', maxWidth: 640 }} /><p className="settings-note">没经过审核、可能不完整的印象，看不清的细节就当不知道。</p>{read.impressions.map((entry) => <div key={entry.tier}><strong>{TIERS[entry.tier]} · {entry.status === 'guarded' ? '读回来了' : '没采用'}</strong><pre>{entry.fragments.join('\n')}</pre></div>)}</article>}
    <SettingsIssue code={error} />
  </section>
}

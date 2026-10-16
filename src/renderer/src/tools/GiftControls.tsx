import { useEffect, useRef, useState } from 'react'
import '@google/model-viewer'
import type { AppBridge, AppSnapshot, GeneratedGiftView, GiftObjectId } from '../../../shared'
import { GIFT_OBJECT_IDS } from '../../../shared'
import { sendCommand } from '../book/command'

function GiftModel({ gift }: { gift: GeneratedGiftView }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!gift.assetUrl || !root.current) return
    const model = document.createElement('model-viewer'); model.setAttribute('src', gift.assetUrl); model.setAttribute('camera-controls', ''); model.setAttribute('loading', 'eager'); model.setAttribute('alt', '生成的礼物 · ' + gift.objectId)
    model.style.cssText = 'width:100%;height:240px'; model.addEventListener('load', () => { model.dataset.loaded = 'true' }); root.current.append(model)
    return () => model.remove()
  }, [gift.assetUrl, gift.objectId])
  return <div ref={root} />
}
export function GiftControls({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const [selected, setSelected] = useState(''); const [objectId, setObjectId] = useState<GiftObjectId>('cup'); const [error, setError] = useState('')
  const view = snapshot.gifts; if (!view) return null
  const memories = snapshot.memory?.items.filter((memory) => memory.kind === 'experience' && !memory.supersededBy) ?? []
  const send = async (body: Parameters<typeof sendCommand>[2]) => { const result = await sendCommand(bridge, snapshot.epoch, body); setError(result.ok ? '' : result.code) }
  return <div aria-label="生成礼物控制"><h2>生成礼物</h2><p>{view.configured ? '已配置 · 每天最多一次提交（失败也计入）' : '尚未配置生成服务'} · 物件描述不含姓名、课程或邮件</p>
    <select aria-label="礼物来源经历" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">选择已见经历</option>{memories.map((memory) => <option key={memory.id} value={memory.id}>{memory.text.slice(0, 45)}</option>)}</select>
    <select aria-label="礼物物件" value={objectId} onChange={(event) => setObjectId(event.target.value as GiftObjectId)}>{GIFT_OBJECT_IDS.map((id) => <option key={id}>{id}</option>)}</select>
    <button disabled={!view.configured || !selected} onClick={() => void send({ type: 'gift.propose', sourceMemoryId: selected, objectId, motif: 'plain' })}>提议礼物</button>
    {view.items.map((gift) => <div key={gift.id} data-gift-status={gift.status}><p>{gift.objectId} · {gift.status} · {gift.source === 'fake' ? '合成生成服务' : '真实生成服务'}</p>
      {gift.status === 'proposed' && <button onClick={() => void send({ type: 'gift.start', giftId: gift.id })}>专注中开始制作</button>}
      {['proposed', 'making'].includes(gift.status) && <button onClick={() => void send({ type: 'gift.cancel', giftId: gift.id })}>停止本地等待</button>}
      {gift.assetUrl && <GiftModel gift={gift} />}{gift.error && <p role="alert">生成未完成：{gift.error.code}</p>}</div>)}
    {error && <p role="alert">操作未完成：{error}</p>}
  </div>
}

import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
export function LifeControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState(''); const life = snapshot.life; if (!life) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  const label = { room: '房间', coast: '海岸', swing: '秋千' }; const proposed = life.outings.findLast((outing) => outing.status === 'proposed')
  return <section aria-label="她的生活"><h2>她的生活</h2><p>{life.dayKey} · {label[life.locationId]} · 虚构生活，离线不代表实际工作</p>
    <label>今天的作息<select value={life.userSchedule} onChange={(event) => void send({ type: 'life.schedule', schedule: event.target.value })}><option value="auto">日历兜底</option><option value="work">今天工作</option><option value="rest">今天休息</option></select></label>
    <button onClick={() => void send({ type: 'life.propose', place: 'coast' })}>提议去海岸</button><button onClick={() => void send({ type: 'life.propose', place: 'swing' })}>提议去秋千</button>
    {proposed && <button onClick={() => void send({ type: 'life.depart', outingId: proposed.id })}>同意这次外出</button>}{life.locationId !== 'room' && <button onClick={() => void send({ type: 'life.return' })}>请她提前回来</button>}
    <ul>{life.items.map((item) => <li key={item.id}>{item.kind === 'shell' ? '贝壳' : '树叶'} · {item.dayKey} · {label[item.place]} · {item.display === 'desk' ? '书桌' : '抽屉'}<small> · {item.outingId.slice(-8)}</small></li>)}</ul>
    {error && <p role="alert">{error}</p>}
  </section>
}

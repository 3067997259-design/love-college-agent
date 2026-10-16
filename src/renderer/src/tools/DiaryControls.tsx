import { useEffect, useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, DiaryRead } from '../../../shared'
export function DiaryControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [entry, setEntry] = useState<DiaryRead | null>(null); const [error, setError] = useState('')
  useEffect(() => { setEntry(null); setError('') }, [snapshot.epoch])
  const diary = snapshot.diary; if (!diary) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  return <section aria-label="日记与房间"><h2>日记与房间</h2><p>{diary.source} · {diary.status} · 主观日记不作为事实来源；下一页书签会留下钥匙。</p>
    <button onClick={() => void send({ type: 'room.open' })}>打开她的文件夹</button><button onClick={() => void send({ type: 'room.rebuild' })}>重建房间投影</button>
    <button disabled={diary.status === 'writing' || diary.status === 'unconfigured'} onClick={() => void send({ type: 'diary.write' })}>整理已结束一天的日记</button>
    <ul>{diary.entries.map((item) => <li key={item.id}>{item.dayKey} · {item.unlocked ? '钥匙已在下一页书签' : '锁着'}<button disabled={!item.unlocked || !bridge.readDiary} onClick={() => { void bridge.readDiary!(item.id).then((value) => { setEntry(value); setError('') }, () => setError('日记暂不可读')) }}>用户查阅日记</button></li>)}</ul>
    {entry && <article aria-label="用户独占日记"><h3>{entry.dayKey} · 主观日记</h3><p>ZIP 钥匙：<code>{entry.key}</code></p><pre>{entry.text}</pre><button onClick={() => setEntry(null)}>合上日记</button></article>}
    {error && <p role="alert">{error}</p>}
  </section>
}

import { useEffect, useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, DiaryRead } from '../../../shared'
import { dayKeyLabel } from '../book/life/text'
import { SettingsIssue } from './SettingsIssue'

const STATE = { idle: '', writing: '正在写', failed: '上次没写成，可以再补写', unconfigured: '还没配置写日记的模型' } as const

export function DiaryControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [entry, setEntry] = useState<DiaryRead | null>(null); const [error, setError] = useState('')
  useEffect(() => { setEntry(null); setError('') }, [snapshot.epoch])
  const diary = snapshot.diary; if (!diary) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  return <section aria-label="日记与房间"><h3>日记与房间</h3>
    {(STATE[diary.status] || diary.source === 'fake') && <p>{[diary.source === 'fake' ? '合成日记（开发场景）' : '', STATE[diary.status]].filter(Boolean).join(' · ')}</p>}
    <p className="settings-note">日记是她自己的感受，不当作事实记录。哪天的日记写好了，下一页书签上会挂一把钥匙。</p>
    <div className="settings-actions">
      <button onClick={() => void send({ type: 'room.open' })}>打开她的文件夹</button>
      <button onClick={() => void send({ type: 'room.rebuild' })}>重建她的房间文件夹</button>
      <button disabled={diary.status === 'writing' || diary.status === 'unconfigured'} onClick={() => void send({ type: 'diary.write' })}>补写还没写的日记</button>
    </div>
    {diary.entries.length > 0 && <ul>{diary.entries.map((item) => <li key={item.id}>{dayKeyLabel(item.dayKey)} · {item.unlocked ? '钥匙在下一页书签上' : '还锁着'} <button disabled={!item.unlocked || !bridge.readDiary} onClick={() => { void bridge.readDiary!(item.id).then((value) => { setEntry(value); setError('') }, () => setError('unavailable')) }}>读这篇日记</button></li>)}</ul>}
    {entry && <article aria-label="用户独占日记"><h3>{dayKeyLabel(entry.dayKey)}的日记</h3><p className="settings-note">压缩包密码：<code>{entry.key}</code></p><pre>{entry.text}</pre><button onClick={() => setEntry(null)}>合上日记</button></article>}
    <SettingsIssue code={error} />
  </section>
}

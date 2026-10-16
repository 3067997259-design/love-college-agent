import { useEffect, useState } from 'react'
import type { AppCommand, AppSnapshot } from '../../../shared'
import { connectBridge } from './connect-bridge'

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [notice, setNotice] = useState('')
  useEffect(() => connectBridge(window.lca, setSnapshot, () => setNotice('接口连接失败')), [])
  async function send(body: { type: 'mode.set'; mode: 'quiet' | 'rest' } | { type: 'lights.set'; lightsOut: boolean }) {
    if (!snapshot) return
    const command: AppCommand = { protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), ...body }
    try {
      const ack = await window.lca.dispatch(command)
      setNotice(ack.status === 'rejected' ? ack.error.code : '')
    } catch { setNotice('接口连接失败') }
  }
  return <main data-mode={snapshot?.companion.mode} data-pose={snapshot?.companion.pose} data-location={snapshot?.companion.locationId} data-phase={snapshot?.pomodoro.phase}>
    <h1>Love, College &amp; Agent</h1>
    <p>工程底座：聊天、邮箱与执行功能尚未接通。</p>
    {snapshot && <><p>当前情境：{snapshot.companion.mode} · {snapshot.companion.lightsOut ? '熄灯' : '开灯'}</p>
      <button onClick={() => void send({ type: 'mode.set', mode: 'quiet' })}>安静</button>
      <button onClick={() => void send({ type: 'mode.set', mode: 'rest' })}>休息</button>
      <button onClick={() => void send({ type: 'lights.set', lightsOut: !snapshot.companion.lightsOut })}>切换灯光</button>
    </>}
    {notice && <p role="status">{notice}</p>}
  </main>
}

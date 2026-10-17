import { useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { SettingsIssue } from './SettingsIssue'
import words from '../voice/settings.zh.json'

export function ModelControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState(''); const models = snapshot.modelSettings
  if (!models) return null
  return <div aria-label="模型槽位控制"><h2>模型连接</h2>
    <p>{words.configured}{models.configuredSlots.map((slot) => (words.slots as Record<string, string>)[slot] ?? slot).join('、') || words.none}。</p>
    {snapshot.runtime?.developer.mode === 'developer' ? <p>开发模式使用独立 fake 模型。</p> : <button type="button" disabled={models.status === 'selecting'} onClick={() => { void bridge.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'models.configure' }).then((ack) => setError(ack.status === 'rejected' ? ack.error.code : ''), () => setError('connection-failed')) }}>导入模型配置</button>}
    {models.restartRequired && <p>配置已保存，重启后生效。<button type="button" onClick={() => { void bridge.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'app.restart' }) }}>应用模型配置并重启</button></p>}
    <SettingsIssue code={error || models.error?.code} />
  </div>
}

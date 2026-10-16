import { useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'

export function ModelControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState(''); const models = snapshot.modelSettings
  if (!models) return null
  return <div aria-label="模型槽位控制"><h2>模型连接</h2>
    <p>已配置槽位：{models.configuredSlots.join('、') || '无'}。配置与凭据只由主进程读取。</p>
    {snapshot.runtime?.developer.mode === 'developer' ? <p>开发模式使用独立 fake 模型。</p> : <button type="button" disabled={models.status === 'selecting'} onClick={() => { void bridge.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'models.configure' }).then((ack) => setError(ack.status === 'rejected' ? ack.error.code : ''), () => setError('connection-failed')) }}>导入模型配置</button>}
    {models.restartRequired && <p>配置已保存，重启后生效。<button type="button" onClick={() => { void bridge.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'app.restart' }) }}>应用模型配置并重启</button></p>}
    {(error || models.error) && <p role="alert">模型配置未完成：{error || models.error?.code}</p>}
  </div>
}

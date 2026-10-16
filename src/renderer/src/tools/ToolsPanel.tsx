import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
import './tools.css'

type Action = AppCommand extends infer Command ? Command extends AppCommand ? Omit<Command, 'epoch' | 'protocolVersion' | 'requestId'> : never : never

export function ToolsPanel({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [approving, setApproving] = useState<string | null>(null)
  const send = async (action: Action) => {
    try {
      const ack = await bridge.dispatch({ ...action, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() })
      setError(ack.status === 'rejected' ? ack.error.code : '')
    } catch { setError('connection-failed') }
  }
  if (!snapshot.runtime) return null
  return <aside className="tools-panel">
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>工具与设置</button>
    {open && <section aria-label="工具与设置">
      <button type="button" onClick={() => setOpen(false)}>关闭</button>
      <h2>插件</h2>
      {snapshot.runtime.plugins.map((plugin) => <div className="tools-plugin" key={plugin.id}>
        <strong>{plugin.name}</strong> <small>{plugin.version} · {plugin.status}</small>
        <p>{plugin.tools.join('、') || '仅素材'}</p>
        {plugin.status === 'enabled' ? <button type="button" onClick={() => void send({ type: 'plugin.disable', pluginId: plugin.id })}>停用</button>
          : <button type="button" disabled={['incompatible', 'failed'].includes(plugin.status)} onClick={() => plugin.source === 'folder' ? setApproving(plugin.id) : void send({ type: 'plugin.enable', pluginId: plugin.id, fingerprint: plugin.fingerprint })}>启用</button>}
        <label>隐私过滤 <select value={plugin.privacy} onChange={(event) => void send({ type: 'plugin.privacy.set', pluginId: plugin.id, privacy: event.target.value as 'none' | 'optional' | 'always' })}>
          <option value="none">关闭</option><option value="optional">跟随文件过滤</option><option value="always">总是过滤</option>
        </select></label>
        {approving === plugin.id && <div role="alertdialog" aria-label="插件代码授权">
          <p>这个插件将在主进程执行本地 Node 代码。请先检查来源。声明的权限：{plugin.permissions.join('、') || '无'}。本地代码拥有当前用户的权限。</p>
          <code>{plugin.fingerprint}</code>
          <button type="button" onClick={() => { setApproving(null); void send({ type: 'plugin.enable', pluginId: plugin.id, fingerprint: plugin.fingerprint }) }}>确认此版本并启用</button>
          <button type="button" onClick={() => setApproving(null)}>取消</button>
        </div>}
      </div>)}
      <h2>开发者模式</h2>
      <p>当前：{snapshot.runtime.developer.mode}</p>
      <label><input type="checkbox" checked={snapshot.runtime.developer.requestedEnabled} disabled={snapshot.runtime.developer.mode === 'booth'} onChange={(event) => void send({ type: 'developer.set', enabled: event.target.checked })} />使用独立的假数据与假模型（重启生效）</label>
      {snapshot.runtime.developer.restartRequired && <button type="button" onClick={() => void send({ type: 'app.restart' })}>重启应用</button>}
      {error && <p role="alert">操作未完成：{error}</p>}
    </section>}
  </aside>
}

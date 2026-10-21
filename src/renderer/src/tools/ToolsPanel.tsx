import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
import './tools.css'
import { MailboxControls } from './MailboxControls'
import { DocumentControls } from './DocumentControls'
import { MemoryControls } from './MemoryControls'
import { BackupControls } from './BackupControls'
import { DiagnosticsControls } from './DiagnosticsControls'
import { ModelControls } from './ModelControls'
import { GiftControls } from './GiftControls'
import { LifeControls } from './LifeControls'
import { DiaryControls } from './DiaryControls'
import { NotificationControls } from './NotificationControls'
import { CharacterControls } from './CharacterControls'
import { OpticalControls } from './OpticalControls'
import { MinecraftControls } from './MinecraftControls'
import { VoiceControls } from './VoiceControls'
import { ResourceControls } from './ResourceControls'
import { PomodoroSettings } from './PomodoroSettings'

type Action = AppCommand extends infer Command ? Command extends AppCommand ? Omit<Command, 'epoch' | 'protocolVersion' | 'requestId'> : never : never

export function ToolsPanel({ bridge, snapshot, open: openProp, onOpenChange }: { bridge: AppBridge; snapshot: AppSnapshot; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  // 书本的“设置”书签也能打开这里：开关由 App 持有时听 App 的
  const [ownOpen, setOwnOpen] = useState(false)
  const open = openProp ?? ownOpen
  const setOpen = (value: boolean) => { if (onOpenChange) onOpenChange(value); else setOwnOpen(value) }
  const [error, setError] = useState('')
  const [approving, setApproving] = useState<string | null>(null)
  const send = async (action: Action) => {
    try {
      const ack = await bridge.dispatch({ ...action, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() })
      setError(ack.status === 'rejected' ? ack.error.code : '')
    } catch { setError('connection-failed') }
  }
  // 平时的设置是书里的一页（SettingsPage）；书外的浮动面板只留给开发模式的假数据工具
  if (!snapshot.runtime || snapshot.runtime.developer.mode !== 'developer') return null
  return <aside className="tools-panel settings-surface">
    <button type="button" aria-label="工具与设置" onClick={() => setOpen(!open)} aria-expanded={open}>设置</button>
    {open && <section aria-label="工具与设置">
      <button type="button" onClick={() => setOpen(false)}>关闭</button>
      {snapshot.windows && <button type="button" onClick={() => void send({ type: 'window.mini' })}>收起为迷你窗</button>}
      <MailboxControls bridge={bridge} snapshot={snapshot} />
      <DocumentControls bridge={bridge} snapshot={snapshot} />
      <MemoryControls bridge={bridge} snapshot={snapshot} />
      <OpticalControls bridge={bridge} snapshot={snapshot} />
      <BackupControls bridge={bridge} snapshot={snapshot} />
      <MinecraftControls bridge={bridge} snapshot={snapshot} />
      <VoiceControls bridge={bridge} snapshot={snapshot} />
      <ResourceControls bridge={bridge} snapshot={snapshot} />
      <DiagnosticsControls bridge={bridge} snapshot={snapshot} />
      <ModelControls bridge={bridge} snapshot={snapshot} />
      <GiftControls bridge={bridge} snapshot={snapshot} />
      <LifeControls bridge={bridge} snapshot={snapshot} />
      <DiaryControls bridge={bridge} snapshot={snapshot} />
      <NotificationControls bridge={bridge} snapshot={snapshot} />
      <CharacterControls bridge={bridge} snapshot={snapshot} />
      <PomodoroSettings bridge={bridge} snapshot={snapshot} />
      <h2>插件</h2>
      {snapshot.runtime.plugins.map((plugin) => <div className="tools-plugin" key={plugin.id}>
        <strong>{plugin.name}</strong> <small>{plugin.version} · {plugin.status}</small>
        <p>{plugin.tools.join('、') || '仅素材'}</p>
        {plugin.status === 'enabled' ? <button type="button" onClick={() => void send({ type: 'plugin.disable', pluginId: plugin.id })}>停用</button>
          : <button type="button" disabled={['incompatible', 'failed'].includes(plugin.status)} onClick={() => plugin.source === 'folder' ? setApproving(plugin.id) : void send({ type: 'plugin.enable', pluginId: plugin.id, fingerprint: plugin.fingerprint })}>启用</button>}
        <label>隐私过滤 <select value={plugin.privacy} disabled={plugin.privacyLocked} onChange={(event) => void send({ type: 'plugin.privacy.set', pluginId: plugin.id, privacy: event.target.value as 'none' | 'optional' | 'always' })}>
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
      <button type="button" onClick={() => void send({ type: 'onboarding.reset' })}>重新初始化</button>
      <p>当前：{snapshot.runtime.developer.mode}</p>
      <label><input type="checkbox" checked={snapshot.runtime.developer.requestedEnabled} onChange={(event) => void send({ type: 'developer.set', enabled: event.target.checked })} />使用独立的假数据与假模型（重启生效）</label>
      {snapshot.runtime.developer.restartRequired && <button type="button" onClick={() => void send({ type: 'app.restart' })}>重启应用</button>}
      {snapshot.runtime.developer.mode === 'developer' && <div>
        <p>假模型 · 独立测试存档 · MCP {snapshot.runtime.developer.mcpPort ?? '未连接'} · CDP {snapshot.runtime.developer.cdpPort}</p>
        <p>当前时钟 {snapshot.clock.nowMs} · {snapshot.clock.rate} 倍</p>
        <button type="button" onClick={() => void send({ type: 'developer.clock', frozen: !snapshot.clock.frozen })}>{snapshot.clock.frozen ? '继续时钟' : '冻结时钟'}</button>
        <button type="button" onClick={() => void send({ type: 'developer.clock', nowMs: snapshot.clock.nowMs + 60_000 })}>快进一分钟</button>
        <label>速度 <select value={snapshot.clock.rate} onChange={(event) => void send({ type: 'developer.clock', rate: Number(event.target.value) })}>
          {[1, 10, 60, 3600].map((rate) => <option key={rate} value={rate}>{rate} 倍</option>)}
        </select></label>
        <label>加载测试场景 <select defaultValue="" onChange={(event) => { if (event.target.value) void send({ type: 'developer.scenario', scenarioId: event.target.value as 'empty' | 'clock-tool' | 'pomodoro-demo' }) }}>
          <option value="" disabled>选择后重启</option><option value="empty">空白</option><option value="clock-tool">时钟工具回合</option><option value="pomodoro-demo">番茄演示</option>
        </select></label>
      </div>}
      {error && <p role="alert">操作未完成：{error}</p>}
    </section>}
  </aside>
}

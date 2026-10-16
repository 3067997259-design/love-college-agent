import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
import './tools.css'
import { MailboxControls } from './MailboxControls'
import { DocumentControls } from './DocumentControls'
import { MemoryControls } from './MemoryControls'
import { McpControls } from './McpControls'
import { BackupControls } from './BackupControls'

type Action = AppCommand extends infer Command ? Command extends AppCommand ? Omit<Command, 'epoch' | 'protocolVersion' | 'requestId'> : never : never

export function ToolsPanel({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [approving, setApproving] = useState<string | null>(null)
  const [plannedCount, setPlannedCount] = useState(2)
  const [demo, setDemo] = useState(false)
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
      <MailboxControls bridge={bridge} snapshot={snapshot} />
      <DocumentControls bridge={bridge} snapshot={snapshot} />
      <MemoryControls bridge={bridge} snapshot={snapshot} />
      <BackupControls bridge={bridge} snapshot={snapshot} />
      <McpControls bridge={bridge} snapshot={snapshot} />
      <h2>番茄钟</h2>
      <div aria-label="番茄钟控制" data-phase={snapshot.pomodoro.phase} data-status={snapshot.pomodoro.status}>
        <p>{({ idle: '等待开始', focus: '专注', 'short-break': '短休息', 'long-break': '长休息' })[snapshot.pomodoro.phase]} · {Math.ceil(snapshot.pomodoro.remainingMs / 1000)} 秒 · {snapshot.pomodoro.focusIndex}/{snapshot.pomodoro.plannedCount}</p>
        {snapshot.pomodoro.phaseDurationMs > 0 && <progress aria-label="阶段进度" max={snapshot.pomodoro.phaseDurationMs} value={Math.max(0, snapshot.pomodoro.phaseDurationMs - snapshot.pomodoro.remainingMs)} />}
        <label>计划个数 <select value={plannedCount} onChange={(event) => setPlannedCount(Number(event.target.value))}>{[1, 2, 4, 6].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
        <label><input type="checkbox" checked={demo} onChange={(event) => setDemo(event.target.checked)} />演示节奏：专注 1 分钟，休息 20 秒</label>
        <button type="button" disabled={snapshot.pomodoro.status !== 'idle'} onClick={() => void send({ type: 'pomodoro.plan', plan: {
          label: demo ? '演示计划' : '专注计划', plannedCount, focusDurationMs: demo ? 60_000 : 25 * 60_000,
          shortBreakDurationMs: demo ? 20_000 : 5 * 60_000, longBreakDurationMs: demo ? 20_000 : 15 * 60_000, longBreakEvery: 4, timing: demo ? 'demo' : 'standard',
        } })}>生成待确认计划</button>
        {snapshot.pomodoro.plan && <p>{snapshot.pomodoro.plan.label} · {snapshot.pomodoro.plan.status} · {snapshot.pomodoro.plan.timing === 'demo' ? '演示时长' : '实际时长'}</p>}
        {snapshot.pomodoro.plan?.status === 'proposed' && <button type="button" onClick={() => void send({ type: 'pomodoro.confirm', planId: snapshot.pomodoro.plan!.id })}>确认计划</button>}
        {snapshot.pomodoro.plan?.status === 'confirmed' && snapshot.pomodoro.status === 'idle' && <button type="button" disabled={snapshot.companion.lightsOut} onClick={() => void send({ type: 'pomodoro.start', planId: snapshot.pomodoro.plan!.id })}>开始下一段专注</button>}
        {snapshot.pomodoro.status === 'running' && <button type="button" onClick={() => void send({ type: 'pomodoro.pause' })}>暂停计时</button>}
        {snapshot.pomodoro.status === 'paused' && <button type="button" disabled={snapshot.companion.lightsOut} onClick={() => void send({ type: 'pomodoro.resume' })}>继续计时</button>}
        {snapshot.pomodoro.plan && snapshot.pomodoro.plan.status !== 'finished' && <button type="button" onClick={() => void send({ type: 'pomodoro.stop' })}>结束计划</button>}
      </div>
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
      <p>当前：{snapshot.runtime.developer.mode}</p>
      <label><input type="checkbox" checked={snapshot.runtime.developer.requestedEnabled} disabled={snapshot.runtime.developer.mode === 'booth'} onChange={(event) => void send({ type: 'developer.set', enabled: event.target.checked })} />使用独立的假数据与假模型（重启生效）</label>
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

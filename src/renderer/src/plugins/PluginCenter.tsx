import { useState } from 'react'
import type { AppBridge, AppSnapshot, McpServerView, PluginView } from '../../../shared'
import { sendCommand, type CommandBody } from '../book/command'
import { MinecraftControls } from '../tools/MinecraftControls'
import { SettingsIssue, settingStatus } from '../tools/SettingsIssue'
import copy from '../voice/plugins.zh.json'
import './plugins.css'

type Tab = 'plugins' | 'skills'
type AddMode = 'local' | 'mcp'
type IconKind = 'bell' | 'code' | 'book' | 'eye' | 'puzzle' | 'cube' | 'cap' | 'plug'
type Row =
  | { key: string; kind: 'builtin' | 'folder'; name: string; description: string; icon: IconKind; plugin: PluginView }
  | { key: string; kind: 'mcp'; name: string; description: string; icon: IconKind; server: McpServerView }

const BUILTIN: Record<string, { name: string; description: string; icon: IconKind }> = {
  notifications: { name: '急件提醒', description: '哪些邮件可以弹系统通知', icon: 'bell' },
  coding: { name: '书桌编码', description: '写代码、跑命令、改书桌文件', icon: 'code' },
  'life-work': { name: '自主阅读与写作', description: '她自己的读书笔记和写作', icon: 'book' },
  'optical-memory': { name: '光学记忆', description: '把旧对话印成页，按清晰度回忆', icon: 'eye' },
}

const isGame = (server: McpServerView) => server.tools.includes('get_world_session') || server.id.toLowerCase().includes('mcpfabric')
const isCampus = (server: McpServerView) => server.id.toLowerCase().includes('student') || server.tools.some((name) => /course|campus|calendar|library/i.test(name))
/** 只修显示名；配置、指纹和工具仍按 server.id。 */
const mcpDisplayName = (server: McpServerView) => server.id === 'student-hub' ? 'Student Hub' : server.id

function mcpDescription(server: McpServerView) {
  if (isGame(server)) return 'Minecraft 陪玩'
  if (isCampus(server)) return '校园邮箱、日程与资料'
  return '自定义 MCP 服务器'
}

function PluginIcon({ kind }: { kind: IconKind }) {
  return (
    <span className="plugin-icon" data-icon={kind} aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'bell' && <><path d="M12 4c-3.2 0-5 2.2-5 5.3v3.4L5 16h14l-2-3.3V9.3C17 6.2 15.2 4 12 4Z" /><path d="M10 18.5a2.2 2.2 0 0 0 4 0" /></>}
        {kind === 'code' && <><path d="m9 7-5 5 5 5M15 7l5 5-5 5" /></>}
        {kind === 'book' && <><path d="M5 5.5h8.5A2.5 2.5 0 0 1 16 8v10.5H7.5A2.5 2.5 0 0 1 5 16Z" /><path d="M5 16a2.5 2.5 0 0 1 2.5-2.5H16" /></>}
        {kind === 'eye' && <><path d="M2.8 12s3.3-5.2 9.2-5.2S21.2 12 21.2 12s-3.3 5.2-9.2 5.2S2.8 12 2.8 12Z" /><circle cx="12" cy="12" r="2.4" /></>}
        {kind === 'puzzle' && <><path d="M9 4h4v2.2a2 2 0 1 0 0 4V12h3.8a2 2 0 1 1 0 4H13v4H9v-4H6.2a2 2 0 1 1 0-4H9V8.2A2 2 0 1 0 9 4Z" /></>}
        {kind === 'cube' && <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>}
        {kind === 'cap' && <><path d="m3 9 9-4 9 4-9 4-9-4Z" /><path d="M7 11v4.2c0 1.2 2.2 2.3 5 2.3s5-1.1 5-2.3V11" /><path d="M21 9v5" /></>}
        {kind === 'plug' && <><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5Z" /><path d="M12 16v5" /></>}
      </svg>
    </span>
  )
}

export function PluginCenter({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const [tab, setTab] = useState<Tab>('plugins')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [approving, setApproving] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [rowError, setRowError] = useState('')
  const [addMode, setAddMode] = useState<AddMode | null>(null)
  const [addMenu, setAddMenu] = useState(false)
  const [path, setPath] = useState('')
  const [dialogError, setDialogError] = useState('')
  const [notice, setNotice] = useState('')

  const mode = snapshot.runtime?.developer.mode ?? 'normal'
  const plugins = snapshot.runtime?.plugins ?? []
  const servers = snapshot.mcp?.servers ?? []

  const builtinRows: Row[] = plugins
    .filter((plugin) => plugin.source === 'builtin' && (BUILTIN[plugin.id] || plugin.id === 'developer' && mode === 'developer'))
    .map((plugin) => ({
      key: plugin.id, kind: 'builtin', name: BUILTIN[plugin.id]?.name ?? plugin.name,
      description: BUILTIN[plugin.id]?.description ?? plugin.description ?? plugin.name,
      icon: BUILTIN[plugin.id]?.icon ?? 'puzzle', plugin,
    }))
  const externalRows: Row[] = [
    ...plugins.filter((plugin) => plugin.source === 'folder').map((plugin): Row => ({
      key: plugin.id, kind: 'folder', name: plugin.name, description: plugin.description ?? '本地插件', icon: 'puzzle', plugin,
    })),
    ...servers.map((server): Row => ({
      key: `mcp:${server.id}`, kind: 'mcp', name: mcpDisplayName(server), description: mcpDescription(server),
      icon: isGame(server) ? 'cube' : isCampus(server) ? 'cap' : 'plug', server,
    })),
  ]
  const visible = (rows: Row[]) => rows.filter((row) => {
    const query = search.trim().toLowerCase()
    return !query || row.name.toLowerCase().includes(query) || row.description.toLowerCase().includes(query)
  })
  const skills = [
    ...plugins.filter((plugin) => plugin.source === 'folder' && plugin.status === 'enabled')
      .flatMap((plugin) => plugin.tools.map((name) => ({ key: `${plugin.id}:${name}`, name, source: plugin.name }))),
    ...servers.filter((server) => server.status === 'ready')
      .flatMap((server) => server.tools.map((name) => ({ key: `${server.id}:${name}`, name, source: server.id }))),
  ]

  const dispatch = async (body: CommandBody, key: string) => {
    setBusy(key); setRowError('')
    const result = await sendCommand(bridge, snapshot.epoch, body)
    setBusy('')
    if (!result.ok) setRowError(result.code)
    return result
  }

  const toggle = (row: Row) => {
    if (busy) return
    if (row.kind === 'mcp') {
      const server = row.server
      if (server.status === 'ready' || server.status === 'connecting') void dispatch({ type: 'mcp.disconnect', serverId: server.id }, row.key)
      else { setExpanded(row.key); setApproving(row.key) }
      return
    }
    const plugin = row.plugin
    if (plugin.status === 'enabled') { void dispatch({ type: 'plugin.disable', pluginId: plugin.id }, row.key); return }
    if (plugin.status === 'needs-approval') { setExpanded(row.key); setApproving(row.key); return }
    if (plugin.status !== 'incompatible' && plugin.status !== 'failed') void dispatch({ type: 'plugin.enable', pluginId: plugin.id, fingerprint: plugin.fingerprint }, row.key)
  }

  const approve = async (row: Row) => {
    if (row.kind === 'mcp') {
      const result = await dispatch({ type: 'mcp.connect', serverId: row.server.id, fingerprint: row.server.fingerprint }, row.key)
      if (result.ok) setApproving(null)
      return
    }
    const result = await dispatch({ type: 'plugin.enable', pluginId: row.plugin.id, fingerprint: row.plugin.fingerprint }, row.key)
    if (result.ok) setApproving(null)
  }

  const openAdd = (next: AddMode) => {
    setAddMode(next); setAddMenu(false); setPath(''); setDialogError(''); setNotice('')
  }

  const submitAdd = async () => {
    if (!addMode || !path.trim() || busy) return
    setBusy('add'); setDialogError('')
    const body: CommandBody = addMode === 'mcp'
      ? { type: 'mcp.configure.path', path: path.trim() }
      : { type: 'plugin.install', path: path.trim() }
    const result = await sendCommand(bridge, snapshot.epoch, body)
    setBusy('')
    if (!result.ok) { setDialogError(result.code); return }
    setNotice(addMode === 'mcp' ? copy.mcpOk : copy.installedOk)
    setAddMode(null); setPath('')
  }

  const renderRow = (row: Row) => {
    const open = expanded === row.key || approving === row.key
    const enabled = row.kind === 'mcp'
      ? row.server.status === 'ready' || row.server.status === 'connecting'
      : row.plugin.status === 'enabled'
    const disabled = busy === row.key
      || row.kind === 'folder' && ['incompatible', 'failed'].includes(row.plugin.status)
      || row.kind === 'builtin' && ['incompatible', 'failed'].includes(row.plugin.status)
    return (
      <li key={row.key} className="plugin-row" data-plugin-id={row.kind === 'mcp' ? row.server.id : row.plugin.id} data-plugin-kind={row.kind} data-open={open}>
        <div className="plugin-row-head">
          <button type="button" className="plugin-row-main" onClick={() => setExpanded(open && expanded === row.key ? null : row.key)} aria-expanded={open}>
            <PluginIcon kind={row.icon} />
            <span className="plugin-row-text"><strong>{row.name}</strong><small>{row.description}</small></span>
          </button>
          <button type="button" className="plugin-switch" role="switch" aria-checked={enabled} aria-label={`${row.name} · ${enabled ? (row.kind === 'mcp' ? copy.disconnect : copy.disable) : (row.kind === 'mcp' ? copy.connect : copy.enable)}`}
            data-on={enabled} disabled={disabled} onClick={() => toggle(row)}>
            <span />
          </button>
        </div>
        {open && <div className="plugin-row-config">
          {row.kind === 'mcp' ? <McpConfig row={row} snapshot={snapshot} bridge={bridge} approving={approving === row.key} onApprove={() => void approve(row)} onCancel={() => setApproving(null)} /> : <PluginConfig row={row} busy={busy === row.key} approving={approving === row.key} onPrivacy={(privacy) => void dispatch({ type: 'plugin.privacy.set', pluginId: row.plugin.id, privacy }, row.key)} onApprove={() => void approve(row)} onCancel={() => setApproving(null)} />}
        </div>}
      </li>
    )
  }

  return (
    <section className="page page-right sheet plugin-center" aria-label={copy.title}>
      <aside className="plugin-rail" aria-label={copy.custom}>
        <p className="plugin-rail-head">{copy.custom}</p>
        <button type="button" className="plugin-rail-tab" data-active={tab === 'plugins'} onClick={() => setTab('plugins')}>{copy.plugins}</button>
        <button type="button" className="plugin-rail-tab" data-active={tab === 'skills'} onClick={() => setTab('skills')}>{copy.skills}</button>
        <p className="plugin-rail-sub">{copy.installed}</p>
        {externalRows.map((row) => (
          <button type="button" key={row.key} className="plugin-rail-item" onClick={() => { setTab('plugins'); setExpanded(row.key) }}>{row.name}</button>
        ))}
      </aside>

      <div className="plugin-main">
        <header className="plugin-head">
          <div>
            <h2 className="plugin-title">{tab === 'plugins' ? copy.plugins : copy.skills}</h2>
            <p className="plugin-lead">{tab === 'plugins' ? copy.lead : copy.skillsLead}</p>
          </div>
          {tab === 'plugins' && <div className="plugin-add">
            <button type="button" className="btn btn-primary btn-small" onClick={() => setAddMenu(!addMenu)}>+ {copy.add}</button>
            {addMenu && <div className="plugin-add-menu" role="menu" aria-label={copy.add}>
              <button type="button" role="menuitem" onClick={() => openAdd('local')}>{copy.addLocal}</button>
              <button type="button" role="menuitem" onClick={() => openAdd('mcp')}>{copy.addMcp}</button>
            </div>}
          </div>}
        </header>

        {tab === 'plugins' ? <>
          <input className="plugin-search" type="search" aria-label={copy.search} placeholder={copy.search} value={search} onChange={(event) => setSearch(event.target.value)} />
          {notice && <p className="plugin-notice" role="status">{notice}</p>}
          <div className="plugin-scroll">
            <h3 className="plugin-section">{copy.builtin}</h3>
            <ul className="plugin-list">{visible(builtinRows).map(renderRow)}</ul>
            <h3 className="plugin-section">{copy.installedPlugins}</h3>
            {externalRows.length === 0
              ? <p className="plugin-empty">{copy.empty}</p>
              : visible(externalRows).length === 0
                ? <p className="plugin-empty">{copy.searchEmpty}</p>
                : <ul className="plugin-list">{visible(externalRows).map(renderRow)}</ul>}
            <SettingsIssue code={rowError || snapshot.mcp?.error?.code} />
          </div>
        </> : (
          <div className="plugin-scroll">
            {skills.length === 0 ? <p className="plugin-empty">{copy.skillsEmpty}</p> : (
              <ul className="plugin-skills">
                {skills.map((skill) => <li key={skill.key}><span className="plugin-skill-name">{skill.name}</span><small>{skill.source}</small></li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      {addMode && <div className="plugin-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAddMode(null) }}>
        <section className="plugin-dialog" role="dialog" aria-modal="true" aria-label={copy.addTitle}>
          <h3>{copy.addTitle}</h3>
          <p>{addMode === 'mcp' ? copy.addMcpLead : copy.addLocalLead}</p>
          <input autoFocus className="plugin-dialog-input" aria-label={addMode === 'mcp' ? copy.addMcp : copy.addLocal} value={path} placeholder={copy.addPlaceholder}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submitAdd() }} />
          <p className="plugin-dialog-note">{copy.addNote}</p>
          {dialogError && <p className="plugin-dialog-error" role="alert">{addMode === 'mcp' ? copy.mcpFailed : copy.installFailed} <code>{dialogError}</code></p>}
          <div className="card-actions">
            <button type="button" className="btn btn-primary btn-small" disabled={!path.trim() || busy === 'add'} onClick={() => void submitAdd()}>{copy.install}</button>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setAddMode(null)}>{copy.cancel}</button>
          </div>
        </section>
      </div>}
    </section>
  )
}

function PluginConfig({ row, busy, approving, onPrivacy, onApprove, onCancel }: {
  row: Extract<Row, { kind: 'builtin' | 'folder' }>
  busy: boolean
  approving: boolean
  onPrivacy: (privacy: PluginView['privacy']) => void
  onApprove: () => void
  onCancel: () => void
}) {
  const plugin = row.plugin
  return <div className="plugin-config">
    <p className="plugin-meta">{settingStatus(plugin.status)} · {plugin.version} · {plugin.source === 'builtin' ? copy.sourceBuiltin : copy.sourceFolder}</p>
    <p className="plugin-meta">{copy.toolsLabel}：{plugin.tools.length ? plugin.tools.join('、') : copy.noTools}</p>
    {plugin.permissions.length > 0 && <p className="plugin-meta">{copy.permissions}：{plugin.permissions.join('、')}</p>}
    {plugin.privacyLocked
      ? <p className="plugin-meta">{copy.privacy}：{copy.privacyAlways}</p>
      : <label className="plugin-privacy">{copy.privacy}
        <select value={plugin.privacy} disabled={busy} onChange={(event) => onPrivacy(event.target.value as PluginView['privacy'])}>
          <option value="none">{copy.privacyNone}</option>
          <option value="optional">{copy.privacyOptional}</option>
          <option value="always">{copy.privacyAlways}</option>
        </select>
      </label>}
    <details className="plugin-details"><summary>{copy.fingerprint}</summary><code>{plugin.fingerprint}</code></details>
    {approving && <div className="plugin-approval" role="alertdialog" aria-label={copy.confirm}>
      <p>{copy.approvalHint}</p>
      <div className="card-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={onApprove}>{copy.confirm}</button>
        <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={onCancel}>{copy.cancel}</button>
      </div>
    </div>}
  </div>
}

function McpConfig({ row, snapshot, bridge, approving, onApprove, onCancel }: {
  row: Extract<Row, { kind: 'mcp' }>
  snapshot: AppSnapshot
  bridge: AppBridge
  approving: boolean
  onApprove: () => void
  onCancel: () => void
}) {
  const server = row.server
  const gameMode = snapshot.runtime?.developer.mode !== 'normal'
  return <div className="plugin-config">
    <p className="plugin-meta">{settingStatus(server.status)} · {server.transport === 'stdio' ? '本地服务' : '远程服务'} · {server.tools.length} 项工具</p>
    <p className="plugin-meta">{copy.privacy}：{server.privacy === 'always' ? copy.privacyAlways : copy.privacyNone}</p>
    <details className="plugin-details"><summary>{copy.fingerprint}</summary><code>{server.fingerprint}</code></details>
    {server.tools.length > 0 && <details className="plugin-details"><summary>{copy.toolsLabel} · {server.tools.length}</summary><p>{server.tools.join('、')}</p></details>}
    {approving && <div className="plugin-approval" role="alertdialog" aria-label={copy.mcpApprove}>
      <p>{copy.mcpApproveHint}</p>
      <code>{server.fingerprint}</code>
      <div className="card-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={onApprove}>{copy.mcpConfirm}</button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>{copy.cancel}</button>
      </div>
    </div>}
    {isGame(server) && (gameMode
      ? <div className="plugin-game"><MinecraftControls bridge={bridge} snapshot={snapshot} /></div>
      : <><p className="plugin-meta">{copy.gameHint}</p><p className="plugin-note">{copy.gameNotConnected}</p></>)}
  </div>
}

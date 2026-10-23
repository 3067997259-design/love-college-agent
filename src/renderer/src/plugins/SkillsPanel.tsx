import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { sendCommand, type CommandBody } from '../book/command'
import { SettingsIssue } from '../tools/SettingsIssue'

export function SkillsPanel({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const view = snapshot.skills
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [search, setSearch] = useState('')
  const project = snapshot.work?.current.path
  const refreshed = useRef('')
  const extensionBusy = snapshot.extensions?.status === 'reconciling' || snapshot.extensions?.operations.some((op) => op.outcome === 'pending')
  useEffect(() => {
    const key = `${snapshot.epoch}:${project}`
    if (extensionBusy || refreshed.current === key) return
    refreshed.current = key
    void sendCommand(bridge, snapshot.epoch, { type: 'skills.refresh' }).then((result) => { if (!result.ok) setError(result.code) })
  }, [bridge, snapshot.epoch, project, extensionBusy])
  const send = async (body: CommandBody) => {
    setPending(true); setError(''); const result = await sendCommand(bridge, snapshot.epoch, body)
    setPending(false); if (!result.ok) setError(result.code)
  }
  const busy = pending || view?.status === 'loading' || snapshot.extensions?.operations.some((op) => op.outcome === 'pending') || snapshot.extensions?.status === 'reconciling'
  const operation = view?.operation
  const items = view?.items.filter((item) => `${item.name} ${item.description} ${item.sourceLabel}`.toLowerCase().includes(search.toLowerCase().trim())) ?? []
  return <div className="plugin-scroll skills-panel">
    <p className="plugin-meta">当前项目：{snapshot.work?.current.name ?? '书桌'}。同名时依次采用项目 .dsh、项目 .agents、此存档的技能；扩展也可提供技能。</p>
    <div className="card-actions">
      <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void send({ type: 'skills.refresh' })}>刷新技能</button>
      <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void send({ type: 'skills.import', scope: 'project' })}>导入到当前项目</button>
      <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void send({ type: 'skills.import', scope: 'profile' })}>导入到此存档</button>
    </div>
    <input className="plugin-search" type="search" aria-label="搜索技能" placeholder="搜索技能" value={search} onChange={(event) => setSearch(event.target.value)} />
    {view?.status !== 'ready' && <p className="plugin-notice" role="status">{view?.status === 'loading' ? '正在读取技能……' : view?.status === 'failed' ? '部分目录无法读取，请检查后刷新。' : '刷新后查看当前项目可用的技能。'}</p>}
    {operation && <div className="plugin-notice" role="status">{operation.action === 'import' ? '导入' : '移除'}：{operation.outcome === 'pending' ? operation.phase === 'awaiting-approval' ? '等待你批准' : '准备中' : { succeeded: '已完成', cancelled: '已取消', failed: '未完成；检查目录或同名技能后重试' }[operation.outcome]}
      {operation.outcome === 'pending' && <button type="button" className="btn btn-small btn-ghost" disabled={pending} onClick={() => void send({ type: 'skills.cancel', operationId: operation.id })}>取消操作</button>}
    </div>}
    {!items.length && view?.status === 'ready' && <p className="plugin-empty">{search ? '没有匹配的技能。' : '还没有 Markdown 技能。可以导入一个含 SKILL.md 的目录。'}</p>}
    <ul className="plugin-skills">{items.map((skill) => <li key={skill.id} data-skill-id={skill.id} data-skill-status={skill.status}>
      <details>
        <summary><span className="plugin-skill-name">{skill.name}</span><small>{{ available: '可用', shadowed: '被同名技能覆盖', invalid: '解析失败或不允许的链接', missing: '缺少 SKILL.md' }[skill.status]}</small></summary>
        <p className="plugin-meta">{skill.description}</p><p className="plugin-meta">{skill.sourceLabel}</p>
        {skill.status === 'available' && <p className="plugin-meta">{skill.modelInvocable ? '她可以按需读取' : '禁止模型主动调用'} · {skill.userInvocable ? '允许用户调用' : '不提供用户调用'}</p>}
        {skill.fingerprint && <details className="plugin-details"><summary>来源指纹</summary><code>{skill.fingerprint}</code></details>}
        {skill.removable ? <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void send({ type: 'skills.remove', skillId: skill.id, fingerprint: skill.fingerprint, projectKey: view!.projectKey })}>移除技能</button> : <p className="plugin-meta">原有或已修改的文件，请在来源目录维护后刷新。</p>}
      </details>
    </li>)}</ul>
    <SettingsIssue code={error || view?.error?.code} />
  </div>
}

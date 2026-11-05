import { useEffect, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import type { AgentView } from '../../../shared/collaboration'
import { sendCommand, type CommandBody } from './command'
import { activityKind } from '../voice/activity-text'
import './collaboration.css'

const activity = { starting: '正在加入', running: '工作中', waiting: '等待中', inactive: '空闲', stopping: '正在停止', unavailable: '不可用' }
const outcome = { none: '', completed: '本次运行已结束', aborted: '已中止', failed: '执行失败', refused: '未获批准', unknown: '结果不明' }
const waiting = { approval: '等你批准', member: '等同伴', budget: '额度不足', user: '需要新的明确指令', recovery: '等待恢复' }
const target = (member: AgentView) => ({ address: member.address, expectedRevision: member.revision })
const modeText = (member: AgentView) => member.mode === 'teammate' ? '团队成员' : member.mode === 'fork' ? '上下文委派' : '临时助手'
/** Shared with the team room's member card, so both say the same thing about a member. A member with no turn now is
 * described by how her last run ended, not as merely idle. */
export const memberText = {
  activity, outcome, waiting, mode: modeText,
  status: (member: AgentView) => member.waitingFor ? waiting[member.waitingFor] : member.activity === 'inactive' && member.outcome !== 'none' ? outcome[member.outcome] : activity[member.activity],
}
export const memberTarget = target
export const memberWorkText = (member: AgentView): string | null => !member.work ? null : member.work.phase === 'thinking' ? '在想下一步'
  : member.work.phase === 'note' ? '看同伴的消息' : activityKind({ templateId: member.work.templateId ?? 'dsh.other' }) ?? '处理一步工作'

export function CollaborationPanel({ snapshot, bridge, openRequest = 0, shot }: {
  snapshot: AppSnapshot; bridge: AppBridge
  /** Bumped by the team room's "更多": opens the sheet and re-checks the members. */
  openRequest?: number
  /** The left page's room / desk view switch, shown beside the tab while there are helpers. */
  shot?: { team: boolean; onToggle(): void }
}) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const view = snapshot.collaboration
  const members = view?.members.filter((member) => member.mode !== 'root') ?? []
  const root = view?.members.find((member) => member.mode === 'root')
  const busy = view?.operation?.phase === 'running'
  const command = async (body: CommandBody) => { const result = await sendCommand(bridge, snapshot.epoch, body); setFailed(!result.ok); return result.ok }
  const refresh = () => { void command({ type: 'agent.refresh' }) }
  // Only a new request opens the sheet.
  useEffect(() => { if (openRequest) { setOpen(true); refresh() } }, [openRequest])
  // 没有帮手、也没有共同任务时，这颗按钮收成页角一个几乎看不见的小点：书房里不该常驻一块写着“协作”的牌子。
  // 有成员、有任务或面板已打开时，恢复原来的按钮与面板结构（aria-expanded / aria-controls 不变）。
  const quiet = !open && !members.length && !view?.tasks.length && !shot
  return <div className="collaboration room-ui" data-photo-omit>
    {shot && <button type="button" className="collaboration-tab collaboration-shot" aria-pressed={shot.team} onClick={shot.onToggle}>{shot.team ? '回到桌前' : '看看房间'}</button>}
    <button type="button" className={quiet ? 'collaboration-tab collaboration-quiet' : 'collaboration-tab'} data-quiet={quiet || undefined}
      aria-expanded={open} aria-controls="collaboration-panel" aria-label={quiet ? '协作' : undefined} title={quiet ? '协作' : undefined}
      onClick={() => { setOpen(!open); if (!open) refresh() }}>{quiet ? null : <>协作{members.length ? ` · ${members.length}` : ''}</>}</button>
    {open && <section id="collaboration-panel" className="collaboration-sheet" aria-label="成员与共同任务">
      <header><h2>一起做的事</h2><button type="button" aria-label="收起协作" onClick={() => setOpen(false)}>收起</button></header>
      <p className="collaboration-note">小而独立的事交给临时助手，要分工、交接的事就组个团队。</p>
      {view?.workSelection && <label>查看哪件事<select aria-label="协作工作" value={view.workSelection.workId ?? ''} onChange={event => { void command({ type: 'agent.refresh', workId: event.target.value || null }) }}>
        <option value="">当前对话</option>{view.workSelection.choices.map(work => <option key={work.workId} value={work.workId}>{work.label}{work.available ? '' : ' · 未运行'}</option>)}
      </select></label>}
      <div className="collaboration-actions"><button type="button" disabled={busy} onClick={refresh}>刷新</button>{root && <button type="button" disabled={busy} onClick={() => { void command({ type: 'agent.stop-family', target: target(root) }) }}>停止整组</button>}</div>
      {view?.capacity && <p className="collaboration-note">团队名册 {view.capacity.teamUsed} / {view.capacity.teamLimit} · 同时运行最多 {view.capacity.activeLimit} 个<br />停下的成员还占着名册位置，空闲的也可能占着运行名额。</p>}
      {(!view || view.status !== 'ready') && <p role="status">{view?.status === 'failed' ? '连接断了，刷新会重新连上。' : '开始工作后，可以在这里查看成员。'}</p>}
      {view?.status === 'ready' && !members.length && <p>目前由她独自处理。需要帮手时，成员会出现在这里。</p>}
      {members.map((member) => <Member key={`${member.address.runtimeId}:${member.address.sessionId}`} member={member} disabled={!!busy || !!snapshot.companion.lightsOut || snapshot.companion.sleeping || view?.operation?.outcome === 'unknown'} command={command} />)}
      {!!view?.tasks.length && <section aria-label="共同任务"><h3>共同任务</h3>{view.tasks.map((task) => <article className="collaboration-task" key={task.id}>
        <strong>{task.subject}</strong><small>{task.id} · 第 {task.revision} 版 · {{ open: '待领取', claimed: '进行中', completed: '已完成', deleted: '已移除' }[task.status]}</small>
        {task.ownerSessionId && <span>负责：{view.members.find((member) => member.address.sessionId === task.ownerSessionId)?.name ?? '原成员'}</span>}
        {!!task.blockedBy.length && <span>依赖：{task.blockedBy.join('、')}</span>}
        {task.scopeOverlap && <span>写入范围有重叠，需要协调。</span>}
        {task.sourceStatus === 'retired' && <span>旧来源内容已收起，继续前需要新证据。</span>}
        {root && task.status !== 'deleted' && <div className="collaboration-actions">{(task.status === 'open' ? ['claim'] as const : task.status === 'claimed' ? ['release', 'complete'] as const : ['reopen'] as const).map((action) => <button type="button" disabled={busy || view.operation?.outcome === 'unknown' || snapshot.companion.lightsOut || snapshot.companion.sleeping} key={action} onClick={() => { void command({ type: 'team.task.update', target: target(root), taskId: task.id, expectedTaskRevision: task.revision, action }) }}>{{ claim: '主角色领取', release: '释放任务', complete: '确认任务完成', reopen: '重新打开' }[action]}</button>)}</div>}
      </article>)}</section>}
      {(failed || view?.operation?.outcome === 'failed') && <p role="alert">这次没办成，状态可能变了，刷新看看。</p>}
      {view?.operation?.outcome === 'unknown' && <p role="alert">还不知道结果。先刷新看看，别重复发。</p>}
      {view?.operation?.outcome === 'accepted' && <p className="collaboration-note" role="status">请求收到了，结果看成员的状态。</p>}
    </section>}
  </div>
}

function Member({ member, disabled, command }: { member: AgentView; disabled: boolean; command(body: CommandBody): Promise<boolean> }) {
  const [text, setText] = useState('')
  return <details className="collaboration-member"><summary><strong>{member.name}</strong><span>{member.waitingFor ? waiting[member.waitingFor] : activity[member.activity]}</span></summary>
    <small>{modeText(member)}{member.taskLabel ? ` · ${member.taskLabel}` : ''}</small>
    {memberWorkText(member) && <p>当前操作：{memberWorkText(member)}</p>}
    {member.outcome !== 'none' && <p>{outcome[member.outcome]}</p>}
    {member.resultText && <p className="collaboration-result">{member.resultText}</p>}
    {member.sources.status !== 'clean' && <p className="collaboration-note">涉及外部来源，原文不在这里展开。</p>}
    <small>已预留 {member.usage.admittedUnits.toLocaleString()} 单位{member.usage.inputTokens !== null && ` · 输入 ${member.usage.inputTokens} / 输出 ${member.usage.outputTokens ?? '未知'} tokens`}</small>
    {member.controls.message && <form onSubmit={(event) => { event.preventDefault(); void command({ type: 'agent.message', target: target(member), text }).then((ok) => { if (ok) setText('') }) }}>
      <label>给这位成员的新指令<textarea value={text} onChange={(event) => setText(event.target.value)} rows={2} maxLength={8000} disabled={disabled} /></label>
      <button type="submit" disabled={disabled || !text.trim()}>发送指令</button>
    </form>}
    {member.controls.interrupt && <button type="button" disabled={disabled} onClick={() => { void command({ type: 'agent.interrupt', target: target(member) }) }}>停止当前工作</button>}
  </details>
}

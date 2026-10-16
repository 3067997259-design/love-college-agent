import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot, CandidateView, DeliveryView, MessageView } from '../../../shared'
import { activityText } from '../voice/activity-text'
import { CandidateCard, DeliveryCard, TaskCard } from './cards'
import { formatClock } from './format'
import { useCountdown } from './useCountdown'
import { FileIntake } from '../tools/FileIntake'

type Item =
  | { kind: 'message'; at: number; id: string; view: MessageView }
  | { kind: 'candidate'; at: number; id: string; view: CandidateView }
  | { kind: 'delivery'; at: number; id: string; view: DeliveryView }
  | { kind: 'task'; at: number; id: string }

/**
 * 入场动画只给“这次运行里新出现的”卡片：首个快照、重启、恢复只挂载不重播（src/shared/README.md）。
 * 换 epoch（恢复存档、切场景）时把当时已有的 id 都记为见过。
 */
function useEnteringIds(snapshot: AppSnapshot): Set<string> {
  const seen = useRef<{ epoch: string; ids: Set<string> } | null>(null)
  const ids = [...snapshot.candidates.map((c) => c.id), ...snapshot.deliveries.map((d) => d.id)]
  if (!seen.current || seen.current.epoch !== snapshot.epoch) {
    seen.current = { epoch: snapshot.epoch, ids: new Set(ids) }
    return new Set()
  }
  const fresh = new Set(ids.filter((id) => !seen.current!.ids.has(id)))
  for (const id of fresh) seen.current.ids.add(id)
  return fresh
}

export function RightPage({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const { messages, candidates, deliveries, task, activities, pomodoro, privacy } = snapshot
  const entering = useEnteringIds(snapshot)
  const streamRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [commandError, setCommandError] = useState('')

  // 任务卡没有时间戳：放在发起它的那条用户消息、以及她紧接着的那句应答后面
  const lastUserIndex = messages.findLastIndex((m) => m.role === 'user')
  const reply = lastUserIndex >= 0 ? messages[lastUserIndex + 1] : undefined
  const lastUserAt = (reply?.role === 'assistant' ? reply : messages[lastUserIndex])?.createdAtMs ?? 0
  const items: Item[] = [
    ...messages.map((view) => ({ kind: 'message' as const, at: view.createdAtMs, id: view.id, view })),
    ...candidates.filter((c) => c.status !== 'ignored').map((view) => ({ kind: 'candidate' as const, at: view.createdAtMs, id: view.id, view })),
    ...deliveries.map((view) => ({ kind: 'delivery' as const, at: view.createdAtMs, id: view.id, view })),
    ...(task ? [{ kind: 'task' as const, at: lastUserAt + 0.5, id: task.id }] : []),
  ].sort((a, b) => a.at - b.at)
  const orphanActivities = activities.filter((a) => a.taskId !== task?.id)

  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [items.length, messages.at(-1)?.text])

  async function dispatch(body: DistributiveOmit<AppCommand, 'protocolVersion' | 'requestId' | 'epoch'>) {
    const command = { protocolVersion: 1, requestId: crypto.randomUUID(), epoch: snapshot.epoch, ...body } as AppCommand
    try {
      const ack = await bridge.dispatch(command)
      setCommandError(ack.status === 'rejected' ? (ack.error.code === 'not-configured' ? '聊天模型尚未连接，文字已保留。' : '当前操作未完成，请稍后重试。') : '')
      return ack.status === 'accepted'
    } catch { setCommandError('连接暂时中断，文字已保留。'); return false }
  }
  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try { if (await dispatch({ type: 'message.send', text })) setDraft((current) => current.trim() === text ? '' : current) }
    finally { setSending(false) }
  }

  return (
    <section className="page page-right" aria-label="你的页面">
      <header className="page-head">
        <span className="page-date">{dayTitle(snapshot.clock.nowMs)}</span>
        <TomatoRow snapshot={snapshot} />
      </header>

      <div className="stream" ref={streamRef}>
        {items.map((item) => {
          switch (item.kind) {
            case 'message': return <Message key={item.id} view={item.view} />
            case 'task': return task && <TaskCard key={item.id} task={task} activities={activities} />
            case 'candidate': return (
              <CandidateCard key={`${item.id}:${item.view.revision ?? 0}`} view={item.view} bridge={bridge} entering={entering.has(item.id)}
                onCommand={(type, candidateId, expectedRevision, plannedCompletionIso) => { void dispatch(type === 'candidate.confirm' ? { type, candidateId, expectedRevision, plannedCompletionIso } : { type, candidateId, expectedRevision }) }} />
            )
            case 'delivery': return (
              <DeliveryCard key={item.id} view={item.view} entering={entering.has(item.id)}
                onOpen={(artifactId) => { void dispatch({ type: 'artifact.open', artifactId }) }} />
            )
          }
        })}
        {orphanActivities.length > 0 && (
          <ul className="activities">
            {orphanActivities.map((a) => (
              <li key={a.id} className="activity" data-status={a.status}>
                {activityText(a)}{a.error && <span className="notice-mark" title={a.error.detailsId ? `诊断编号 ${a.error.detailsId}` : undefined}>！</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <FileIntake snapshot={snapshot} bridge={bridge} />
      <footer className="composer">
        {commandError && <span role="alert" className="notice-mark" title={commandError} aria-label={commandError}>！</span>}
        {privacy.fileFilteringEnabled && <span className="filter-mark" title="/privacy 开着：附件和拖进来的文件只交给隐私模型">滤芯</span>}
        <textarea
          className="composer-input" rows={1} value={draft} placeholder="写点什么……"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
        />
        {task && (task.status === 'running' || task.status === 'queued' || task.status === 'waiting-user')
          ? <button className="btn btn-ghost" onClick={() => { void dispatch({ type: 'turn.stop', taskId: task.id }) }}>停止</button>
          : null}
        <button className="btn btn-primary" onClick={() => { void send() }} disabled={!draft.trim() || sending}>发送</button>
      </footer>
      {pomodoro.phase === 'focus' && <div className="focus-veil" aria-hidden />}
    </section>
  )
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function Message({ view }: { view: MessageView }) {
  return (
    <p className={`msg msg-${view.role}`} data-status={view.status}>
      {view.role === 'assistant' && <span className="msg-who" aria-label="桃子" />}
      <span className="msg-text">{view.text}</span>
      {view.status === 'streaming' && <span className="speech-caret" />}
      {(view.status === 'interrupted' || view.status === 'undelivered') && (
        <span className="notice-mark" title={view.status === 'interrupted' ? '说到一半断了' : '没有送达'}>！</span>
      )}
      <time className="msg-time">{formatClock(view.createdAtMs)}</time>
    </p>
  )
}

/** 番茄格：做完的涂上她的颜色，正在进行的按进度填，没开始的只有铅笔框 */
function TomatoRow({ snapshot }: { snapshot: AppSnapshot }) {
  const { pomodoro } = snapshot
  const remaining = useCountdown(snapshot)
  if (pomodoro.plannedCount <= 0) return <div className="tomatoes tomatoes-empty">今天还没开始专注</div>
  const progress = pomodoro.phaseDurationMs > 0 ? 1 - remaining / pomodoro.phaseDurationMs : 0
  return (
    <div className="tomatoes" role="img" aria-label={`第 ${pomodoro.focusIndex} 个，共 ${pomodoro.plannedCount} 个`}>
      {Array.from({ length: pomodoro.plannedCount }, (_, i) => {
        const index = i + 1
        const state = index < pomodoro.focusIndex || (index === pomodoro.focusIndex && pomodoro.phase !== 'focus')
          ? 'done' : index === pomodoro.focusIndex ? 'active' : 'todo'
        return (
          <span key={i} className="tomato" data-state={state}>
            {state === 'active' && <span className="tomato-fill" style={{ transform: `scaleY(${Math.min(1, Math.max(0, progress))})` }} />}
          </span>
        )
      })}
    </div>
  )
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function dayTitle(ms: number): string {
  // 1970-01-01 是周四；按 UTC+8 取日期
  const days = Math.floor((ms + 8 * 3600_000) / 86_400_000)
  const { month, day } = civilFromDays(days)
  return `${month}月${day}日 ${WEEKDAYS[(days + 4) % 7]}`
}
/** Howard Hinnant 的 civil_from_days：天数 → 公历日期 */
function civilFromDays(z: number) {
  z += 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day }
}

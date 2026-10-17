import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot, CandidateView, DeliveryView, GeneratedGiftView, MessageView, ModelFailureView, PomodoroPlanView, QuillView } from '../../../shared'
import { activityText } from '../voice/activity-text'
import { CandidateCard, DeliveryCard, GiftCard, MadeGiftCard, PlanCard, RestoreCard, TaskCard } from './cards'
import { sourceText } from './life/text'
import book from '../voice/book.zh.json'
import { QuoteChip, type Quote } from './history/OldPage'
import { sendCommand, type CommandBody } from './command'
import { civilFromDays, formatClock } from './format'
import { rhythmText, tomatoStates } from './plan'
import { useCountdown } from './useCountdown'
import { FileIntake } from '../tools/FileIntake'
import { FlowApproval, FlowPanel } from './flow/FlowPanel'
import { QuestionControls } from './QuestionControls'
import { CommandDock, Notice } from './CommandControls'
import { RewindDock } from './RewindControls'
import { FailureDetails } from './FailureDetails'
import failureWords from '../voice/failure.zh.json'
import { quoteOnPage } from './history/quote'

type Item =
  | { kind: 'message'; at: number; id: string; view: MessageView }
  | { kind: 'candidate'; at: number; id: string; view: CandidateView }
  | { kind: 'delivery'; at: number; id: string; view: DeliveryView }
  | { kind: 'plan'; at: number; id: string; view: PomodoroPlanView }
  | { kind: 'gift'; at: number; id: string; view: QuillView }
  | { kind: 'made'; at: number; id: string; view: GeneratedGiftView }
  | { kind: 'task'; at: number; id: string }

/** 送出了的礼物（主进程判定 given 才算）：在送出的那一刻进对话 */
const givenGifts = (snapshot: AppSnapshot) => (snapshot.gifts?.items ?? []).filter((gift) => gift.status === 'given' && gift.givenAtMs !== null)

/**
 * 入场动画只给“这次运行里新出现的”卡片：首个快照、重启、恢复只挂载不重播（src/shared/README.md）。
 * 换 epoch（恢复存档、切场景）时把当时已有的 id 都记为见过。
 */
function useEnteringIds(snapshot: AppSnapshot): Set<string> {
  const seen = useRef<{ epoch: string; ids: Set<string> } | null>(null)
  const ids = [...snapshot.candidates.map((c) => c.id), ...snapshot.deliveries.map((d) => d.id), ...(snapshot.pomodoro.plan ? [snapshot.pomodoro.plan.id] : []),
    ...(snapshot.pomodoro.proposal ? [snapshot.pomodoro.proposal.id] : []),
    ...(snapshot.quill?.state === 'given' ? [snapshot.quill.id] : []), ...givenGifts(snapshot).map((gift) => gift.id)]
  if (!seen.current || seen.current.epoch !== snapshot.epoch) {
    seen.current = { epoch: snapshot.epoch, ids: new Set(ids) }
    return new Set()
  }
  const fresh = new Set(ids.filter((id) => !seen.current!.ids.has(id)))
  for (const id of fresh) seen.current.ids.add(id)
  return fresh
}

export function RightPage({ snapshot, bridge, hidden = false, onOpenShelf, onTurnBack, quote = null, onClearQuote, onRestoreQuote }: {
  snapshot: AppSnapshot
  bridge: AppBridge
  /** 翻到别的书签时这一页留着（草稿和滚动位置都在），只是不显示 */
  hidden?: boolean
  onOpenShelf?: () => void
  /** 有前几天的页才能往回翻 */
  onTurnBack?: () => void
  /** 从旧页引用来的一段：发送时连同问题交给主进程回忆（history.recall），不当普通消息发 */
  quote?: Quote | null
  onClearQuote?: () => void
  onRestoreQuote?: (quote: Quote) => void
}) {
  const { messages, candidates, deliveries, task, activities, pomodoro, privacy, quill, backup } = snapshot
  const recall = snapshot.history?.recall
  const herName = snapshot.onboarding?.characterName ?? '桃子'
  // 恢复完成（或恢复失败）的回执一直留着，直到你点“好”收起（backup.cancel 清掉回执）
  const restoreReceipt = backup && (backup.status === 'restored' || (backup.status === 'failed' && backup.error?.code === 'restore-failed')) ? backup : null
  const entering = useEnteringIds(snapshot)
  const streamRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [commandError, setCommandError] = useState('')
  const composerState = useRef({ draft, quote, epoch: snapshot.epoch }); composerState.current = { draft, quote, epoch: snapshot.epoch }
  const restoring = useRef(false)
  async function restoreRequest(source: MessageView, failure: ModelFailureView) {
    if (draft.trim() || quote || restoring.current) { setCommandError(failureWords.draftExists); return }
    restoring.current = true; const epoch = snapshot.epoch
    try {
      let restored: Quote | null = null
      if (failure.sourceRecallAnchor) {
        if (!bridge.readSession || !onRestoreQuote) throw new Error('RECALL_UNAVAILABLE')
        const anchor = failure.sourceRecallAnchor; const page = await bridge.readSession(anchor.sessionId)
        const text = page.messages.find((message) => message.id === anchor.messageId)?.text.slice(anchor.start, anchor.end) ?? ''
        restored = text.trim() && anchor.start >= 0 && anchor.end > anchor.start ? quoteOnPage({ anchor, text, dayKey: page.dayKey }, page) : null
        if (!restored) throw new Error('RECALL_UNAVAILABLE')
      }
      // A page read can finish after a new draft, quote or profile has arrived.
      if (composerState.current.epoch !== epoch) return
      if (composerState.current.draft.trim() || composerState.current.quote) { setCommandError(failureWords.draftExists); return }
      if (restored) onRestoreQuote?.(restored)
      setCommandError(''); setDraft(source.text); inputRef.current?.focus()
    } catch { setCommandError(failureWords.recallUnavailable) }
    finally { restoring.current = false }
  }

  // 任务卡没有时间戳：放在发起它的那条用户消息、以及她紧接着的那句应答后面
  const lastUserIndex = messages.findLastIndex((m) => m.role === 'user')
  const reply = lastUserIndex >= 0 ? messages[lastUserIndex + 1] : undefined
  const lastUserAt = (reply?.role === 'assistant' ? reply : messages[lastUserIndex])?.createdAtMs ?? 0
  const items: Item[] = [
    ...messages.map((view) => ({ kind: 'message' as const, at: view.createdAtMs, id: view.id, view })),
    ...candidates.filter((c) => c.status !== 'ignored').map((view) => ({ kind: 'candidate' as const, at: view.createdAtMs, id: view.id, view })),
    ...deliveries.map((view) => ({ kind: 'delivery' as const, at: view.createdAtMs, id: view.id, view })),
    ...(pomodoro.plan ? [{ kind: 'plan' as const, at: pomodoro.plan.createdAtMs, id: pomodoro.plan.id, view: pomodoro.plan }] : []),
    // 草案单独一张卡：确认前不动生效的计划和已经做完的番茄（src/shared/README.md）
    ...(pomodoro.proposal ? [{ kind: 'plan' as const, at: pomodoro.proposal.createdAtMs, id: pomodoro.proposal.id, view: pomodoro.proposal }] : []),
    ...(quill?.state === 'given' && quill.givenAtMs !== null ? [{ kind: 'gift' as const, at: quill.givenAtMs, id: quill.id, view: quill }] : []),
    ...givenGifts(snapshot).map((view) => ({ kind: 'made' as const, at: view.givenAtMs!, id: view.id, view })),
    ...(task ? [{ kind: 'task' as const, at: lastUserAt + 0.5, id: task.id }] : []),
  ].sort((a, b) => a.at - b.at)
  const orphanActivities = activities.filter((a) => a.taskId !== task?.id)

  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [items.length, messages.at(-1)?.text, restoreReceipt?.status])

  async function dispatch(body: CommandBody) {
    const result = await sendCommand(bridge, snapshot.epoch, body)
    const isMessage = body.type === 'message.send'
    setCommandError(result.ok ? '' : result.code === 'disconnected'
      ? (isMessage ? '连接暂时中断，文字已保留。' : '连接暂时中断，请稍后重试。')
      : (isMessage && result.code === 'not-configured' ? '聊天模型尚未连接，文字已保留。' : '当前操作未完成，请稍后重试。'))
    return result.ok
  }
  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const body: CommandBody = quote ? { type: 'history.recall', anchor: quote.anchor, question: text } : { type: 'message.send', text }
      if (await dispatch(body)) {
        setDraft((current) => current.trim() === text ? '' : current)
        if (quote) onClearQuote?.()
      }
    } finally { setSending(false) }
  }
  const recalling = recall?.status === 'recalling'

  return (
    <section className="page page-right" aria-label="你的页面" hidden={hidden}>
      <header className="page-head">
        <span className="page-head-date">
          <span className="page-date">{dayTitle(snapshot.clock.nowMs)}</span>
          {onTurnBack && <button type="button" className="link-button turn-back" onClick={onTurnBack}>‹ {book.history.back}</button>}
        </span>
        <PlanHead snapshot={snapshot} onCommand={(body) => { void dispatch(body) }} />
      </header>

      <div className="stream" ref={streamRef}>
        <FlowPanel bridge={bridge} snapshot={snapshot} />
        {items.map((item) => {
          switch (item.kind) {
            case 'message': {
              const failure = item.view.failure
              if (!failure) return <Message key={item.id} view={item.view} />
              // 失败旁白：书的旁白，不是她说的话；和原因、带回原请求放在一块
              const source = failure.sourceMessageId ? messages.find((message) => message.role === 'user' && message.id === failure.sourceMessageId) : undefined
              return (
                <div key={item.id} className="narration">
                  <Message view={item.view} />
                  <FailureDetails failure={failure} onDraft={source ? () => { void restoreRequest(source, failure) } : undefined} />
                </div>
              )
            }
            case 'task': return task && <TaskCard key={item.id} task={task} activities={activities} />
            case 'candidate': return (
              <CandidateCard key={`${item.id}:${item.view.revision ?? 0}`} view={item.view} bridge={bridge} entering={entering.has(item.id)}
                onCommand={(type, candidateId, expectedRevision, plannedCompletionIso) => { void dispatch(type === 'candidate.confirm' ? { type, candidateId, expectedRevision, plannedCompletionIso } : { type, candidateId, expectedRevision }) }} />
            )
            case 'delivery': return (
              <DeliveryCard key={item.id} view={item.view} entering={entering.has(item.id)}
                onOpen={(artifactId) => { void dispatch({ type: 'artifact.open', artifactId }) }} />
            )
            case 'gift': return <GiftCard key={item.id} entering={entering.has(item.id)} />
            case 'made': return <MadeGiftCard key={item.id} gift={item.view} from={sourceText(snapshot, item.view.sourceMemoryId)} entering={entering.has(item.id)} onShelf={onOpenShelf} />
            case 'plan': return (
              <PlanCard key={item.id} plan={item.view} pomodoro={pomodoro} entering={entering.has(item.id)}
                onConfirm={() => { void dispatch({ type: 'pomodoro.confirm', planId: item.id }) }}
                onDismiss={() => { void dispatch({ type: 'pomodoro.discard', planId: item.id }) }} />
            )
          }
        })}
        {restoreReceipt && <RestoreCard view={restoreReceipt} onDone={() => { void dispatch({ type: 'backup.cancel' }) }} />}
        {/* 回忆中：书本旁白一样的小字，不替她说话；她的回答照常作为她的话出现 */}
        {recalling && <p className="msg msg-narrator recall-line" role="status">{book.history.recalling.replace('{name}', herName)}</p>}
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

      {/* 停在输入框上面：她的提问、要你确认的回退和命令、要你批准的代码；你的话没送达也在这里说明 */}
      <div className="dock">
        <QuestionControls snapshot={snapshot} bridge={bridge} />
        <RewindDock snapshot={snapshot} bridge={bridge} />
        <CommandDock snapshot={snapshot} bridge={bridge} />
        <FlowApproval snapshot={snapshot} bridge={bridge} />
        {commandError && <Notice>{commandError}</Notice>}
      </div>
      <FileIntake snapshot={snapshot} bridge={bridge} />
      <footer className="composer">
        {quote && <QuoteChip quote={quote} onClear={() => onClearQuote?.()} />}
        {commandError && <span className="notice-mark" title={commandError} aria-hidden>！</span>}
        {privacy.fileFilteringEnabled && <span className="filter-mark" title="/privacy 开着：附件和拖进来的文件只交给隐私模型">滤芯</span>}
        <textarea
          ref={inputRef}
          className="composer-input" rows={1} value={draft} placeholder={quote ? book.history.placeholder : '写点什么……'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
        />
        {task && (task.status === 'running' || task.status === 'queued' || task.status === 'waiting-user')
          ? <button className="btn btn-ghost" onClick={() => { void dispatch({ type: 'turn.stop', taskId: task.id }) }}>停止</button>
          : null}
        <button className="btn btn-primary" onClick={() => { void send() }} disabled={!draft.trim() || sending || (!!quote && recalling)}>发送</button>
      </footer>
      {pomodoro.phase === 'focus' && <div className="focus-veil" aria-hidden />}
    </section>
  )
}

function Message({ view }: { view: MessageView }) {
  return (
    <p className={`msg msg-${view.role}`} data-status={view.status}>
      {view.role === 'assistant' && <span className="msg-who" aria-label="桃子" />}
      {view.role === 'narrator' && <span className="narrator-tag">{failureWords.label}</span>}
      <span className="msg-text">{view.text}</span>
      {view.status === 'streaming' && <span className="speech-caret" />}
      {(view.status === 'interrupted' || view.status === 'undelivered') && (
        <span className="notice-mark" title={view.status === 'interrupted' ? '说到一半断了' : '没有送达'}>！</span>
      )}
      <time className="msg-time">{formatClock(view.createdAtMs)}</time>
    </p>
  )
}

const BREAK_TEXT = { 'short-break': '短休息', 'long-break': '长休息' } as const
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/**
 * 顶部：今天的计划和番茄格，你确认以后才出现（技术方案 §3.5）。
 * 做完的涂上她的颜色并打勾，正在做的按进度填，没开始的只有铅笔框。
 * 下一个专注不自动开始：休息结束后这里出现“开始第 N 个”，等你点。
 */
function PlanHead({ snapshot, onCommand }: { snapshot: AppSnapshot; onCommand: (body: CommandBody) => void }) {
  const { pomodoro, companion } = snapshot
  const plan = pomodoro.plan
  const remaining = useCountdown(snapshot)
  if (!plan || plan.status === 'proposed' || pomodoro.plannedCount <= 0) {
    return <div className="plan-head plan-head-empty">{pomodoro.proposal || plan?.status === 'proposed' ? '计划等你确认' : '今天还没排番茄'}</div>
  }
  const progress = pomodoro.phaseDurationMs > 0 ? 1 - remaining / pomodoro.phaseDurationMs : 0
  const canStart = plan?.status === 'confirmed' && pomodoro.status === 'idle' && pomodoro.focusIndex < pomodoro.plannedCount
  const lightsHint = companion.lightsOut ? '熄灯时计时暂停，开灯后再继续' : undefined
  return (
    <div className="plan-head">
      {plan && pomodoro.plannedCount <= 10 && <span className="plan-label" title={plan.label}>{plan.label}</span>}
      {plan?.timing === 'demo' && <span className="demo-tag" title={rhythmText(plan)}>演示节奏</span>}
      <div className="tomatoes" data-dense={pomodoro.plannedCount > 6} role="img" aria-label={`第 ${pomodoro.focusIndex} 个，共 ${pomodoro.plannedCount} 个`}>
        {tomatoStates(pomodoro).map((state, i) => (
          <span key={i} className="tomato" data-state={state}>
            {state === 'active' && <span className="tomato-fill" style={{ transform: `scaleY(${clamp01(progress)})` }} />}
          </span>
        ))}
      </div>
      {canStart && (
        <button type="button" className="btn btn-primary btn-small" disabled={companion.lightsOut} title={lightsHint}
          onClick={() => onCommand({ type: 'pomodoro.start', planId: plan.id })}>
          {pomodoro.focusIndex === 0 ? '开始专注' : `开始第 ${pomodoro.focusIndex + 1} 个`}
        </button>
      )}
      {pomodoro.phase === 'focus' && pomodoro.status === 'running' && (
        <button type="button" className="btn btn-ghost btn-small" onClick={() => onCommand({ type: 'pomodoro.pause' })}>暂停</button>
      )}
      {pomodoro.phase === 'focus' && snapshot.windows?.mode === 'book' && (
        <button type="button" className="btn btn-ghost btn-small" title="书合上，缩成桌面角落的小窗；计时照走"
          onClick={() => onCommand({ type: 'window.mini' })}>合上</button>
      )}
      {pomodoro.status === 'paused' && (
        <button type="button" className="btn btn-primary btn-small" disabled={companion.lightsOut} title={lightsHint}
          onClick={() => onCommand({ type: 'pomodoro.resume' })}>继续</button>
      )}
      {(pomodoro.phase === 'short-break' || pomodoro.phase === 'long-break') && <span className="plan-state">{BREAK_TEXT[pomodoro.phase]}</span>}
      {plan?.status === 'finished' && <span className="plan-state">{pomodoro.focusIndex >= pomodoro.plannedCount ? '都做完了' : '收起了'}</span>}
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

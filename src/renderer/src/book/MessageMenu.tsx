import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MessageView, RecontinueCandidateView, RecontinueUnavailable } from '../../../shared'

const REASONS: Record<RecontinueUnavailable, string> = {
  'not-delivered': '这条消息还没送达当前会话',
  'question-answer': '提问的回答不能作为切点',
  'other-project': '这条来自另一个项目或旧会话',
  'no-native-root': '当前会话没有可用的原生记录',
  'no-session': '当前会话还没打开',
  withdrawn: '这条已经撤下',
  busy: '另一个操作正在进行',
}

/**
 * The message is the menu's anchor, not a permanent toolbar. Hover/focus shows
 * the trigger; right-click opens the same menu at the pointer.
 */
export function MessageRow({ view, candidate, retryTarget, children, disabledHint, onRecontinue, onRetry, onFeedback, onCopied }: {
  view: MessageView
  candidate?: RecontinueCandidateView
  retryTarget?: string
  children: ReactNode
  /** A composer draft/quote or an in-flight operation blocks recontinue for now. */
  disabledHint?: string
  onRecontinue?(): void
  onRetry?(): void
  onFeedback?(verdict: 'good' | 'bad'): void
  onCopied?(): void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = () => setOpen(false)
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { close(); trigger.current?.focus() } }
    const scroll = () => close()
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', scroll, true)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); window.removeEventListener('scroll', scroll, true) }
  }, [open])
  const show = (x: number, y: number) => { setPosition({ x, y }); setCopied(false); setOpen(true) }
  const copy = async () => {
    try { await navigator.clipboard.writeText(view.text); setCopied(true); onCopied?.() }
    catch { /* clipboard unavailable: leave the menu open */ }
  }
  const reason = disabledHint ?? (candidate?.available === false ? (candidate.reason ? REASONS[candidate.reason] : '当前会话不能从这里重新继续') : undefined)
  const recontinue = view.role === 'user' && !view.kind && onRecontinue
  const recontinueBlocked = !!reason || candidate?.available === false
  return <div className={`message-row message-row-${view.role}`} data-status={view.status}
    onContextMenu={(event) => { event.preventDefault(); show(event.clientX, event.clientY) }}>
    {children}
    <button ref={trigger} type="button" className="message-actions-trigger" aria-label="消息操作" aria-haspopup="menu" aria-expanded={open}
      onClick={() => { const rect = trigger.current?.getBoundingClientRect(); if (rect) show(rect.right - 4, rect.bottom + 4) }}>⋯</button>
    {open && <div ref={menu} className="message-menu" role="menu" aria-label="消息操作" style={position ? { left: Math.max(8, Math.min(position.x, window.innerWidth - 220)), top: Math.min(position.y, window.innerHeight - 160) } : undefined}
      onContextMenu={(event) => event.preventDefault()}>
      <button type="button" role="menuitem" onClick={() => { close(); void copy() }}>{copied ? '已复制' : '复制'}</button>
      {view.role === 'assistant' && !view.kind && view.status === 'complete' && <>
        <button type="button" role="menuitem" aria-pressed={view.feedback === 'good'} onClick={() => { close(); onFeedback?.('good') }}>{view.feedback === 'good' ? '已标为好' : '好 · 记入短期记忆'}</button>
        <button type="button" role="menuitem" aria-pressed={view.feedback === 'bad'} onClick={() => { close(); onFeedback?.('bad') }}>{view.feedback === 'bad' ? '已标为坏' : '坏 · 不进入记忆'}</button>
        {retryTarget && <button type="button" role="menuitem" onClick={() => { close(); onRetry?.() }}>重新回答</button>}
      </>}
      {recontinue && <button type="button" role="menuitem" disabled={recontinueBlocked} title={reason}
        onClick={() => { close(); onRecontinue() }}>从这里重新开始{reason ? `（${reason}）` : ''}</button>}
    </div>}
  </div>
}

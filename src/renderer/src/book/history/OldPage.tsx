import { useState } from 'react'
import type { MessageView, OpticalMemoryRead, OpticalMemoryView, SessionPage, SessionPageInfo } from '../../../../shared'
import { Impression } from './Impression'
import { MAX_QUOTE, quoteOnPage, type Quote } from './quote'
import copy from '../../voice/book.zh.json'
import { formatClock } from '../format'
import { dayKeyLabel } from '../life/text'

export type { Quote }

/**
 * 往回翻的一页（体验设计 §2“一天一页”）：她的墨色褪成铅笔灰，字始终能读；左页同时换成那天的照片。
 * 只有主进程核对过“她当时确实看见”的句子才能引用（recallableMessageIds），正文由主进程按锚点取，这里只交位置。
 */
export function OldPage({ info, page, failed, older, newer, onTurn, onToday, onQuote, optical = null }: {
  info: SessionPageInfo
  page: SessionPage | null
  failed: boolean
  older: SessionPageInfo | null
  newer: SessionPageInfo | null
  onTurn: (sessionId: string) => void
  onToday: () => void
  onQuote: (quote: Quote) => void
  /** 可选光学记忆开着、这一页封过：她对这一页的印象（只走用户独占读取） */
  optical?: { frames: readonly OpticalMemoryView['frames'][number][]; read: (frameId: string) => Promise<OpticalMemoryRead> } | null
}) {
  const [impression, setImpression] = useState(false)
  const [selection, setPending] = useState<Quote | null>(null)
  // 选段只属于选它的那一页：翻页时组件按 sessionId 重建，这里再兜一层，读取中／失败时也不交别页的锚点（GitHub #19）
  const pending = quoteOnPage(selection, page)
  const recallable = new Set(page?.recallableMessageIds ?? [])

  function select(message: MessageView, span: HTMLElement) {
    if (!page || !recallable.has(message.id)) return
    const selection = window.getSelection()
    if (!selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!span.contains(range.startContainer) || !span.contains(range.endContainer)) return
    const prefix = range.cloneRange()
    prefix.selectNodeContents(span)
    prefix.setEnd(range.startContainer, range.startOffset)
    const start = prefix.toString().length
    const end = start + range.toString().length
    setPending(end > start && end - start <= MAX_QUOTE ? { anchor: { sessionId: page.sessionId, messageId: message.id, start, end }, text: message.text.slice(start, end), dayKey: page.dayKey } : null)
  }
  function whole(message: MessageView): Quote | null {
    if (!page) return null
    let end = Math.min(MAX_QUOTE, message.text.length)
    if (end < message.text.length && /[\uD800-\uDBFF]/.test(message.text[end - 1])) end -= 1
    return { anchor: { sessionId: page.sessionId, messageId: message.id, start: 0, end }, text: message.text.slice(0, end), dayKey: page.dayKey }
  }

  return (
    <section className="page page-right old-page" aria-label={dayKeyLabel(info.dayKey, true)}>
      <header className="page-head">
        <span className="page-date">{dayKeyLabel(info.dayKey, true)}</span>
        <nav className="page-turn" aria-label="翻页">
          {optical && optical.frames.length > 0 && (
            <button type="button" className="link-button impression-toggle" aria-pressed={impression} onClick={() => setImpression(!impression)}>
              {impression ? copy.history.impression.back : copy.history.impression.open}
            </button>
          )}
          <button type="button" className="link-button" disabled={!older} onClick={() => older && onTurn(older.sessionId)}>‹ {copy.history.older}</button>
          <button type="button" className="link-button" onClick={() => newer ? onTurn(newer.sessionId) : onToday()}>{newer ? `${copy.history.newer} ›` : `${copy.history.today} ›`}</button>
        </nav>
      </header>
      <div className="stream old-stream">
        {impression && optical ? <Impression frames={optical.frames} read={optical.read} />
          : failed ? <p className="sheet-status" role="alert">{copy.history.failed}</p>
          : !page ? <p className="sheet-status" role="status">{copy.history.loading}</p>
          : page.messages.length === 0 ? <p className="sheet-empty">{copy.history.empty}</p>
          : <>
            {page.truncated && <p className="old-hint">{copy.history.truncated}</p>}
            {page.messages.map((message) => {
              const canQuote = recallable.has(message.id)
              return (
                <p key={message.id} className={`msg msg-${message.role}`} data-recallable={canQuote} data-message-id={message.id}>
                  {message.role === 'assistant' && <span className="msg-who" aria-hidden />}
                  <span className="msg-text" onMouseUp={(event) => select(message, event.currentTarget)}>{message.text}</span>
                  <time className="msg-time">{formatClock(message.createdAtMs)}</time>
                  {canQuote && (
                    <button type="button" className="quote-button" onClick={() => { const quote = whole(message); if (quote) onQuote(quote) }}>{copy.history.quote}</button>
                  )}
                </p>
              )
            })}
          </>}
      </div>
      <footer className="old-foot">
        {impression ? null : pending
          ? <>
            <blockquote className="quote-preview">{pending.text}</blockquote>
            <button type="button" className="btn btn-primary btn-small" onClick={() => onQuote(pending)}>{copy.history.quoteSelection}</button>
          </>
          : recallable.size > 0 && <p className="old-hint">{copy.history.quoteHint}</p>}
      </footer>
    </section>
  )
}

/** 引用条：回到今天这一页，贴在输入框上面；发送时连同问题交给主进程去回忆 */
export function QuoteChip({ quote, onClear }: { quote: Quote; onClear: () => void }) {
  return (
    <div className="quote-chip">
      <span className="quote-chip-label">{copy.history.chip.replace('{date}', dayKeyLabel(quote.dayKey))}</span>
      <q className="quote-chip-text">{quote.text}</q>
      <button type="button" className="quote-chip-clear" aria-label={copy.history.clearQuote} title={copy.history.clearQuote} onClick={onClear}>×</button>
    </div>
  )
}

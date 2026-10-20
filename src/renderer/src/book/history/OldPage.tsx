import { Fragment, useState } from 'react'
import type { MessageView, OpticalMemoryRead, OpticalMemoryView, SessionPage, SessionPageInfo } from '../../../../shared'
import { Impression } from './Impression'
import { MAX_QUOTE, quoteOnPage, type Quote } from './quote'
import copy from '../../voice/book.zh.json'
import { formatClock } from '../format'
import { dayKeyLabel } from '../life/text'
import { FailureDetails } from '../FailureDetails'
import { MsgText, useMarkdown } from '../MessageText'

export type { Quote }

/**
 * 往回翻的一页（体验设计 §2“一天一页”）：她的墨色褪成铅笔灰，字始终能读；左页同时换成那天的照片。
 * 只有主进程核对过“她当时确实看见”的句子才能引用（recallableMessageIds），正文由主进程按锚点取，这里只交位置。
 */
export function OldPage({ info, page: loadedPage, failed, older, newer, onTurn, onToday, onQuote, optical = null }: {
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
  const showImpression = impression && !!optical?.frames.length
  const [selection, setPending] = useState<Quote | null>(null)
  // 只认这一页、已经读到、没有失败的内容；选段还要可引用、原文仍对得上（GitHub #19，两条线的修复合在一起）
  const page = !failed && loadedPage?.sessionId === info.sessionId ? loadedPage : null
  const recallable = new Set(page?.recallableMessageIds ?? [])
  const selected = quoteOnPage(selection, page)

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
            <button type="button" className="link-button impression-toggle" aria-pressed={showImpression} onClick={() => setImpression(!showImpression)}>
              {showImpression ? copy.history.impression.back : copy.history.impression.open}
            </button>
          )}
          <button type="button" className="link-button" disabled={!older} onClick={() => older && onTurn(older.sessionId)}>‹ {copy.history.older}</button>
          <button type="button" className="link-button" onClick={() => newer ? onTurn(newer.sessionId) : onToday()}>{newer ? `${copy.history.newer} ›` : `${copy.history.today} ›`}</button>
        </nav>
      </header>
      <div className="stream old-stream">
        {showImpression && optical ? <Impression frames={optical.frames} read={optical.read} />
          : failed ? <p className="sheet-status" role="alert">{copy.history.failed}</p>
          : !page ? <p className="sheet-status" role="status">{copy.history.loading}</p>
          : page.messages.length === 0 ? <p className="sheet-empty">{copy.history.empty}</p>
          : <>
            {page.truncated && <p className="old-hint">{copy.history.truncated}</p>}
            {page.messages.map((message) => (
              <Fragment key={message.id}>
                <OldMessage message={message} canQuote={recallable.has(message.id)} onSelect={(span) => select(message, span)}
                  onQuoteWhole={() => { const quote = whole(message); if (quote) onQuote(quote) }} />
                {message.failure && <FailureDetails failure={message.failure} />}
              </Fragment>
            ))}
          </>}
      </div>
      <footer className="old-foot">
        {showImpression ? null : selected
          ? <>
            <blockquote className="quote-preview">{selected.text}</blockquote>
            <button type="button" className="btn btn-primary btn-small" onClick={() => onQuote(selected)}>{copy.history.quoteSelection}</button>
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

/** 旧页上的一句：她的话同样按 Markdown 排；排版不丢原文字符，选段的偏移量仍是原文的偏移量。 */
function OldMessage({ message, canQuote, onSelect, onQuoteWhole }: { message: MessageView; canQuote: boolean; onSelect: (span: HTMLElement) => void; onQuoteWhole: () => void }) {
  const rich = message.role === 'assistant'
  const md = useMarkdown(rich ? message.text : '')
  const Tag = rich && !md.plain ? 'div' : 'p'
  return (
    <Tag className={`msg msg-${message.role}`} data-recallable={canQuote} data-message-id={message.id} data-rich={rich && !md.plain ? 'block' : undefined}>
      {message.role === 'assistant' && <span className="msg-who" aria-hidden />}
      <MsgText md={rich ? md : null} text={message.text} onMouseUp={(event) => onSelect(event.currentTarget)} />
      <time className="msg-time">{formatClock(message.createdAtMs)}</time>
      {canQuote && <button type="button" className="quote-button" onClick={onQuoteWhole}>{copy.history.quote}</button>}
    </Tag>
  )
}

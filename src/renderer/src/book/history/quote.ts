import type { RecallAnchor, SessionPage } from '../../../../shared'

/** 从旧页引用来的一段：主进程只认锚点，正文由它按锚点自己取 */
export interface Quote { anchor: RecallAnchor; text: string; dayKey: string }

/** 主进程最多接受 1000 个 UTF-16 单元的引用；不把一个代理对切成两半 */
export const MAX_QUOTE = 1000

/**
 * 这段选中的话还能不能交出去（GitHub #19）：必须在当前已读到的这一页上、那句仍可引用、
 * 锚点在原文里取出来的还是同一段字。翻页、读取中、读取失败时一律不交别页或过期的锚点。
 */
export function quoteOnPage(quote: Quote | null, page: Pick<SessionPage, 'sessionId' | 'messages' | 'recallableMessageIds'> | null): Quote | null {
  if (!quote || !page || quote.anchor.sessionId !== page.sessionId) return null
  if (!page.recallableMessageIds?.includes(quote.anchor.messageId)) return null
  const message = page.messages.find((item) => item.id === quote.anchor.messageId)
  return message && message.text.slice(quote.anchor.start, quote.anchor.end) === quote.text ? quote : null
}

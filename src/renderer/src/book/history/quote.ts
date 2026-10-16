import type { RecallAnchor, SessionPage } from '../../../../shared'

/** 从旧页引用来的一段：主进程只认锚点，正文由它按锚点自己取 */
export interface Quote { anchor: RecallAnchor; text: string; dayKey: string }

/** 主进程最多接受 1000 个 UTF-16 单元的引用；不把一个代理对切成两半 */
export const MAX_QUOTE = 1000

/** 这段选中的话是不是当前已经读到的这一页上的（GitHub #19：翻页后不能交别页的锚点） */
export function quoteOnPage(quote: Quote | null, page: Pick<SessionPage, 'sessionId'> | null): Quote | null {
  return quote && page && quote.anchor.sessionId === page.sessionId ? quote : null
}

const MEMORY_QUERY_LIMIT = 240

/**
 * Truncates a normalized query at a clause boundary.
 *
 * A blind `slice` can cut a trailing clause in half and change its meaning
 * (for example leaving "不要用" without its object). Cutting at the last
 * separator before the limit keeps whole clauses; a query without separators
 * in the second half still gets the hard cut because dropping most of the
 * request is worse than a partial final clause (MQ-2 step 7).
 */
function truncateAtClauseBoundary(value: string, limit: number): string {
  if (value.length <= limit)
    return value
  const window = value.slice(0, limit)
  const cut = Math.max(window.lastIndexOf('；'), window.lastIndexOf(';'), window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf(' '))
  if (cut < Math.floor(limit / 2))
    return window
  return value.slice(0, cut)
}

/**
 * Creates a shorter retrieval query from a natural-language request.
 *
 * The function removes only common request framing. It keeps negation clauses
 * and action words, so a long request does not become a different claim.
 *
 * @example
 * normalizeMemoryRetrievalQuery('我想在修改接口前先检查现有测试，避免协议已经变了。')
 * // => '修改接口前先检查现有测试；避免协议已经变了'
 */
export function normalizeMemoryRetrievalQuery(query: string): string {
  const compact = query.trim().replace(/\s+/g, ' ')
  if (!compact)
    return ''

  const clauses = compact
    .split(/[，。！？；,!?;]+/u)
    .map(clause => clause.trim())
    .filter(Boolean)

  const withoutRequestFraming = clauses.map((clause) => {
    let next = clause
    next = next.replace(/^(请问|请|麻烦你?|帮我|能否|可以吗|我想要?|我希望|这次|目前|最近|为了)\s*/u, '')
    next = next.replace(/^我们?(想|希望|需要|准备)\s*/u, '')
    next = next.replace(/^在(?=.*(之前|前))/u, '')
    return next.trim()
  }).filter(Boolean)

  if (withoutRequestFraming.length === 0)
    return compact

  // Retain every clause with a negation marker. These markers change the
  // meaning of a preference and must not be lost during normalization.
  const negationClauses = withoutRequestFraming.filter(clause => /[不没未无]|避免|禁止/u.test(clause))
  const actionClauses = withoutRequestFraming.filter(clause => /先|优先|检查|核对|确认|修改|使用|喜欢|习惯|偏好|需要|准备/u.test(clause))
  // Negation clauses lead the normalized form: when a long query must be
  // truncated, action clauses are the ones that fall off the end, never the
  // "do not / avoid" constraints.
  const selected = [...new Set([...negationClauses, ...actionClauses])]
  const normalized = (selected.length > 0 ? selected : withoutRequestFraming).join('；')

  return truncateAtClauseBoundary(normalized, MEMORY_QUERY_LIMIT)
}

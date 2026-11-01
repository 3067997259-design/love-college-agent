import { describe, expect, it } from 'vitest'

import { normalizeMemoryRetrievalQuery } from './query-normalization'

describe('normalizeMemoryRetrievalQuery', () => {
  it('removes request framing and keeps the retrieval action', () => {
    // Negation clauses lead the normalized form (MQ-2 step 7): when a long
    // query is truncated, "avoid / do not" constraints survive and only
    // action clauses fall off the end.
    expect(normalizeMemoryRetrievalQuery('我想在修改 Student Hub 的接口之前，先看一下现有测试，避免协议已经变了。'))
      .toBe('避免协议已经变了；修改 Student Hub 的接口之前；先看一下现有测试')
  })

  it('preserves negation clauses', () => {
    expect(normalizeMemoryRetrievalQuery('请帮我找出我不想成为创业者的相关记忆。'))
      .toContain('不想成为创业者')
  })

  it('returns short queries without inventing content', () => {
    expect(normalizeMemoryRetrievalQuery('奖学金材料')).toBe('奖学金材料')
    expect(normalizeMemoryRetrievalQuery('')).toBe('')
  })

  it('keeps negation clauses whole when a long query is truncated (mq-2)', () => {
    const firstAction = `先检查${'很长的描述'.repeat(30)}`
    const secondAction = `先核对${'另一个很长的描述'.repeat(30)}`
    const query = `${firstAction}，${secondAction}，不要使用旧的部署脚本。`

    const normalized = normalizeMemoryRetrievalQuery(query)

    expect(normalized.length).toBeLessThanOrEqual(240)
    expect(normalized).toContain('不要使用旧的部署脚本')
    // The second action clause is over budget and drops off the end; the
    // negation clause stays because it leads the normalized form.
    expect(normalized).toContain('先检查')
    expect(normalized).not.toContain('先核对')
    // Every kept segment is a whole clause from the query: the cut lands on a
    // boundary instead of splitting a clause in half. The hard cut only runs
    // when no separator exists before the limit.
    for (const segment of normalized.split('；'))
      expect(query).toContain(segment)
  })
})

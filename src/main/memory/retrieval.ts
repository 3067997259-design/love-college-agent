import type { StoredMemory } from './projection'

function tokens(text: string): Set<string> {
  const normalized = text.normalize('NFKC').toLowerCase(); const result = new Set(normalized.match(/[a-z0-9_]+/g) ?? [])
  for (const span of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (span.length === 1) result.add(span)
    for (let index = 0; index + 1 < span.length; index++) result.add(span.slice(index, index + 2))
  }
  return result
}
export function relevance(query: string, text: string): number {
  const left = tokens(query); const right = tokens(text); if (!left.size || !right.size) return 0
  const shared = [...left].filter((token) => right.has(token)).length
  return shared / Math.sqrt(left.size * right.size)
}
export function searchMemories(items: readonly StoredMemory[], query: string, nowMs: number, limit = 5) {
  return items.filter((item) => !item.supersededBy).map((item) => {
    const similarity = relevance(query, item.text); const hours = Math.max(0, nowMs - item.lastMentionedAtMs) / 3600_000
    const halfLife = item.tier === 'long_term' ? 4320 : 24
    return { item, similarity, score: 1.2 * similarity + 0.2 * Math.exp(-hours * Math.LN2 / halfLife) + 0.15 * Math.log1p(item.accessCount) }
  }).filter((match) => match.similarity > 0).sort((a, b) => b.score - a.score || b.item.createdAtMs - a.item.createdAtMs || a.item.id.localeCompare(b.item.id)).slice(0, Math.min(10, Math.max(0, limit)))
}

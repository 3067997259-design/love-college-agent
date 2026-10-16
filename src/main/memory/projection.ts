import type { JournalRecord } from '../journal/schema'
import type { MemoryEntry, MemorySummary } from './schema'

export interface StoredMemory extends MemoryEntry { tier: 'short_term' | 'long_term'; reviewStatus: 'unreviewed'; createdAtMs: number; lastMentionedAtMs: number; accessCount: number; supersededBy?: string }
export function projectMemory(records: readonly JournalRecord[]) {
  const items: StoredMemory[] = []; const summaries: MemorySummary[] = []; const keys = new Set<string>(); const batches = new Set<string>(); const accesses = new Set<string>()
  let lastExtractedAtMs: number | null = null; let lastCompactedAtMs: number | null = null
  for (const row of records) {
    if (row.type === 'memory/batch') {
      if (batches.has(row.batchId)) continue; batches.add(row.batchId); row.keys.forEach((key) => keys.add(key)); lastExtractedAtMs = row.atMs
      for (const entry of row.entries) {
        let stored = items.find((item) => item.id === entry.id)
        if (!stored) { stored = { ...structuredClone(entry), tier: 'short_term', reviewStatus: 'unreviewed', createdAtMs: row.atMs, lastMentionedAtMs: row.atMs, accessCount: 0 }; items.push(stored) }
        else { for (const source of entry.sources) if (!stored.sources.some((old) => old.id === source.id)) stored.sources.push(source); stored.lastMentionedAtMs = row.atMs }
        for (const id of entry.supersedes) { const old = items.find((item) => item.id === id); if (old && !old.supersededBy) old.supersededBy = entry.id }
      }
    } else if (row.type === 'memory/access') {
      for (const id of row.ids) {
        const key = row.requestId + ':' + id; if (accesses.has(key)) continue; accesses.add(key)
        const item = items.find((item) => item.id === id); if (!item || item.supersededBy) continue
        item.accessCount++
      }
    } else if (row.type === 'memory/summary') {
      if (!summaries.some((summary) => summary.id === row.summary.id)) summaries.push(structuredClone(row.summary))
    } else if (row.type === 'context/compact') lastCompactedAtMs = row.atMs
    for (const item of items) if (item.tier === 'short_term' && item.accessCount >= 3 && new Set(item.sources.map((source) => source.sessionId)).size >= 2) item.tier = 'long_term'
  }
  return { items, summaries, keys: [...keys], lastExtractedAtMs, lastCompactedAtMs }
}

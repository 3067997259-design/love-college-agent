import type { JournalRecord } from '../journal/schema'
import type { MemoryScope } from './airi/core'
import type { MemoryCommitCoordinator } from './storage/commits'
import { projectMemory, type StoredMemory } from './projection'
import { memoryDigest, seenFragments, type SeenFragment } from './seen'

const coordinates = (source: Pick<SeenFragment, 'sessionId' | 'frameSeq' | 'index' | 'offset'>) => JSON.stringify([source.sessionId, source.frameSeq, source.index, source.offset])
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

/** Existing derived claims keep their unreviewed status. Migration does not
 * extract from summaries, vaults, old tool bodies, or unsupported source rows. */
export function legacyMemorySources(records: readonly JournalRecord[]) {
  const legacy = projectMemory(records)
  const allowed = seenFragments(records, true)
  const canonical = seenFragments(records, true, true)
  const byCoordinate = new Map(canonical.map(source => [coordinates(source), source]))
  const originals = new Map<string, string>()
  let sessionId = ''
  for (const row of records) {
    if (row.type === 'session/header') sessionId = row.sessionId
    if (row.type === 'model/seen') for (const original of row.originalEvents ?? []) originals.set(JSON.stringify([sessionId, row.seq, original.index]), original.eventId)
  }
  const sources = new Map(allowed.map(source => {
    const original = originals.get(JSON.stringify([source.sessionId, source.frameSeq, source.index]))
    const current = byCoordinate.get(coordinates(source)) ?? (original ? canonical.find(item => item.sourceEventId === original && item.offset === source.offset) : undefined)
    return [source.id, { source, canonical: current ?? source }]
  }))
  const consumed = new Set(legacy.keys)
  const eligible = (item: StoredMemory) => item.sources.every(source => {
    const observed = sources.get(source.id)?.source
    return observed && consumed.has(observed.key) && coordinates(observed) === coordinates(source) && !['tool', 'mail', 'document', 'work'].includes(observed.origin ?? '')
  })
  return { legacy, sources, eligible, capturedKeys: [...new Set(allowed.filter(source => consumed.has(source.key)).map(source => sources.get(source.id)!.canonical.key))] }
}

export async function migrateLegacyMemory(options: { records: readonly JournalRecord[]; scope: MemoryScope; commits: MemoryCommitCoordinator; halfLife: { shortTerm: number; longTerm: number } }) {
  if (options.records.some(row => row.type === 'session/header' && (row.userId !== options.scope.userId || row.characterId !== options.scope.characterId))) throw new Error('MEMORY_MIGRATION_SCOPE_MISMATCH')
  const { legacy, sources, eligible, capturedKeys } = legacyMemorySources(options.records)
  let imported = 0; let archived = 0
  for (const item of legacy.items.filter(item => item.kind === 'fact')) {
    const identity = { operationId: `legacy-memory:${memoryDigest(JSON.stringify([options.scope, item.id]))}`, kind: 'legacy-memory', input: item }
    const result = await options.commits.commit(identity, async (repository, executor) => {
      if (!eligible(item)) return { legacyId: item.id, id: null, disposition: 'archive-only' as const }
      const anchor = sources.get(item.sources[0].id)!.canonical
      const fact = await repository.insert({ content: item.text, scope: options.scope, memoryType: item.tier, reviewStatus: 'pending',
        factStatus: item.supersededBy ? 'superseded' : 'active', category: 'chat', importance: 5, valence: 0, arousal: 0, tags: [], now: item.createdAtMs,
        halfLifeHours: item.tier === 'long_term' ? options.halfLife.longTerm : options.halfLife.shortTerm,
        originId: `legacy:${item.id}`, sessionId: anchor.sessionId,
        sourceContext: { sessionId: anchor.sessionId, messageId: anchor.sourceEventId ? `event:${anchor.sourceEventId}` : anchor.id, sourceType: 'legacy-memory', sourceEventId: item.id, neighbors: [] } })
      // Preserve the old lifecycle observations in the same native transaction;
      // these fields are code-owned and never accepted from model proposals.
      await executor.execute(`UPDATE memory_fragments SET access_count = ${item.accessCount}, last_accessed = ${item.lastMentionedAtMs},
        session_ids_json = ${quote(JSON.stringify([...new Set(item.sources.map(source => source.sessionId))]))} WHERE id = ${quote(fact.id)}`)
      return { legacyId: item.id, id: fact.id, disposition: 'imported' as const }
    })
    if (result.disposition === 'imported') imported++; else archived++
  }
  return { imported, archived, capturedKeys, lastExtractedAt: legacy.lastExtractedAtMs }
}

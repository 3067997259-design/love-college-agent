import assert from 'node:assert/strict'

export interface ContinuityProbeLimits {
  maximumModelRequests: number; maximumReservedUnits: number; maximumAutonomousUnits: number
  maximumEmbeddingRequests?: number; maximumEmbeddingInputCharacters?: number
}

/** Explicit compaction reserves without a conversation turn/model journal row. */
export function compactAdmission(rows: Record<string, unknown>[], baseline: Set<string>, consumed: (ticket: string) => boolean) {
  const fresh = rows.filter(row => row.kind === 'model' && typeof row.id === 'string' && !baseline.has(row.id) && !consumed('compact:' + row.id))
  assert.equal(fresh.length, 1, 'COMPACTION_ADMISSION_AMBIGUOUS')
  const row = fresh[0]
  assert.ok(typeof row.units === 'number' && Number.isSafeInteger(row.units) && row.units > 0 && (row.bucket === 'work' || row.bucket === 'autonomous'), 'COMPACTION_ADMISSION_INVALID')
  return { ticket: 'compact:' + row.id, units: row.units, bucket: row.bucket as 'work' | 'autonomous' }
}

/** Batch counters do not reset at midnight or when a profile is restarted/restored. */
export function createContinuityProbeBudget(limits: ContinuityProbeLimits, reserve: (units: number, bucket: 'work' | 'autonomous') => void) {
  let modelRequests = 0, embeddingRequests = 0, embeddingCharacters = 0, reservedUnits = 0, autonomousUnits = 0
  const consumed = new Set<string>()
  const charge = (ticket: string, units: number, bucket: 'work' | 'autonomous') => {
    assert.ok(!consumed.has(ticket), 'REPLAYED_ADMISSION')
    assert.ok(Number.isSafeInteger(units) && units > 0 && reservedUnits + units <= limits.maximumReservedUnits, 'BATCH_UNITS_EXHAUSTED')
    assert.ok(bucket !== 'autonomous' || autonomousUnits + units <= limits.maximumAutonomousUnits, 'AUTONOMOUS_UNITS_EXHAUSTED')
    reserve(units, bucket); consumed.add(ticket); reservedUnits += units
    if (bucket === 'autonomous') autonomousUnits += units
  }
  return {
    consumed: (ticket: string) => consumed.has(ticket),
    model: (ticket: string, units: number, bucket: 'work' | 'autonomous') => {
      assert.ok(modelRequests < limits.maximumModelRequests, 'MODEL_REQUESTS_EXHAUSTED')
      charge(ticket, units, bucket); modelRequests++
    },
    embedding: (ticket: string, text: string) => {
      assert.ok(embeddingRequests < (limits.maximumEmbeddingRequests ?? 0) && embeddingCharacters + text.length <= (limits.maximumEmbeddingInputCharacters ?? 0), 'EMBEDDING_BUDGET_EXHAUSTED')
      charge(ticket, Buffer.byteLength(text, 'utf8') + 2048, 'autonomous'); embeddingRequests++; embeddingCharacters += text.length
    },
    view: () => ({ modelRequests, embeddingRequests, embeddingCharacters, reservedUnits, autonomousUnits }),
  }
}

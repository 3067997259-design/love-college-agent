import { expect, it } from 'vitest'
import { retrievalRuntimeFailure } from '../../scripts/fixtures/memory-retrieval-diagnostics'

it('distinguishes the production interaction deadline from an unavailable database', () => {
  const deadline = 'Memory embedding exceeded 3000 ms; directory remains available'
  expect(retrievalRuntimeFailure(true, deadline)).toEqual({
    code: 'EMBEDDING_INTERACTION_DEADLINE_EXCEEDED', databaseReady: true,
    embeddingFailure: 'EMBEDDING_INTERACTION_DEADLINE_EXCEEDED',
  })
  expect(retrievalRuntimeFailure(false, deadline)).toMatchObject({ code: 'RETRIEVAL_DATABASE_UNAVAILABLE', databaseReady: false })
  expect(retrievalRuntimeFailure(false, undefined)).toEqual({ code: 'RETRIEVAL_DATABASE_UNAVAILABLE', databaseReady: false, embeddingFailure: null })
  expect(retrievalRuntimeFailure(true, undefined)).toBeNull()
})

it('never includes arbitrary upstream messages or infers a deadline from a partial match', () => {
  const upstream = 'Memory embedding exceeded 3000 ms; directory remains available; secret-fixture-key'
  const report = retrievalRuntimeFailure(true, upstream)
  expect(report).toEqual({ code: 'EMBEDDING_RUNTIME_FAILED', databaseReady: true, embeddingFailure: 'EMBEDDING_RUNTIME_FAILED' })
  expect(JSON.stringify(report)).not.toContain('secret-fixture-key')
})

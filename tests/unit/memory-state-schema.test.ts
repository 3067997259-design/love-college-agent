import { expect, it } from 'vitest'
import { validateMemoryState } from '../../src/main/memory/storage/state-schema'

const scope = { userId: 'u', characterId: 'c' }
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
it('accepts complete original outbox state but rejects credentials, foreign scopes and invalid migration cursors', () => {
  const item = { kind: 'insert', originId: 'fact', content: 'Tea', scope, attempts: 0, nextAttemptAt: 0, createdAt: 1 }
  const state = { 'settings/memory/directory-enabled': true, 'settings/memory/long-term-sync-outbox': [item],
    'settings/memory/embedding-migration': { sourceFingerprint: 'source', ids: ['fact'], nextIndex: 0, total: 1, state: 'idle', updatedAt: 0 } }
  expect(() => validateMemoryState(bytes(state), 'runtime', scope)).not.toThrow()
  expect(() => validateMemoryState(bytes({ ...state, 'settings/memory/api-key': 'synthetic-secret' }), 'runtime', scope)).toThrow()
  expect(() => validateMemoryState(bytes({ ...state, 'settings/memory/long-term-sync-outbox': [{ ...item, scope: { ...scope, userId: 'other' } }] }), 'runtime', scope)).toThrow('SCOPE_MISMATCH')
  expect(() => validateMemoryState(bytes({ ...state, 'settings/memory/embedding-migration': { ...state['settings/memory/embedding-migration'], nextIndex: 2 } }), 'runtime', scope)).toThrow()
  expect(() => validateMemoryState(bytes({ 'captured-sources': { ['a'.repeat(64)]: 1 }, 'last-extracted-at': 1 }), 'capture', scope)).not.toThrow()
  expect(() => validateMemoryState(bytes({ 'captured-sources': { arbitrary: 1 } }), 'capture', scope)).toThrow()
})

import { describe, expect, it } from 'vitest'

import { isMemoryScopeVisible, isSameMemoryScope } from './types'

describe('isSameMemoryScope', () => {
  it('requires both the user and character to match', () => {
    const scope = { userId: 'user-1', characterId: 'character-a' }

    expect(isSameMemoryScope(scope, { ...scope })).toBe(true)
    expect(isSameMemoryScope(scope, { userId: 'user-2', characterId: 'character-a' })).toBe(false)
    expect(isSameMemoryScope(scope, { userId: 'user-1', characterId: 'character-b' })).toBe(false)
    expect(isSameMemoryScope(scope, undefined)).toBe(false)
  })
})

describe('isMemoryScopeVisible', () => {
  it('keeps the character exact while linked user ids widen the user dimension (mq-2)', () => {
    const active = { userId: 'account-1', characterId: 'character-a' }

    expect(isMemoryScopeVisible({ userId: 'account-1', characterId: 'character-a' }, active)).toBe(true)
    expect(isMemoryScopeVisible({ userId: 'local', characterId: 'character-a' }, active, ['local'])).toBe(true)
    // Without the explicit link the anonymous history stays invisible.
    expect(isMemoryScopeVisible({ userId: 'local', characterId: 'character-a' }, active)).toBe(false)
    expect(isMemoryScopeVisible({ userId: 'other-account', characterId: 'character-a' }, active, ['local'])).toBe(false)
    // Character identity is never widened, even for a linked user.
    expect(isMemoryScopeVisible({ userId: 'local', characterId: 'character-b' }, active, ['local'])).toBe(false)
    expect(isMemoryScopeVisible(undefined, active, ['local'])).toBe(false)
  })
})

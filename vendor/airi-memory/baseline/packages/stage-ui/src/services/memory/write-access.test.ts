import { describe, expect, it } from 'vitest'

import { resolveMemoryWriteAccess } from './write-access'

describe('memory write access', () => {
  it('grants write access only to the elected leader window', () => {
    expect(resolveMemoryWriteAccess('?synced-leader=true')).toBe('leader')
    expect(resolveMemoryWriteAccess('?synced-leader=false')).toBe('follower')
    expect(resolveMemoryWriteAccess('?synced-leader=false&stage-runtime=minimal')).toBe('follower')
  })

  it('defaults to follower when the query is missing or malformed', () => {
    expect(resolveMemoryWriteAccess('')).toBe('follower')
    expect(resolveMemoryWriteAccess('?other=1')).toBe('follower')
    expect(resolveMemoryWriteAccess('?synced-leader=maybe')).toBe('follower')
  })
})

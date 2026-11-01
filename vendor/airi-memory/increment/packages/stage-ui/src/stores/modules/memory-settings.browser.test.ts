import type { LeadershipMode, SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { useDuckDb } from '../../composables/use-duck-db'
import { useMemoryStore } from './memory'

const contexts: Array<{ pinia: ReturnType<typeof createPinia>, runtime: SyncedPiniaRuntime }> = []
const originalUrl = location.href

function context(namespace: string, leadership: LeadershipMode) {
  const url = new URL(location.href)
  url.searchParams.set('synced-leader', leadership === 'leader-only' ? 'true' : 'false')
  history.replaceState(null, '', url)
  const pinia = createPinia()
  const runtime = createSyncedPiniaPlugin({ namespace, leadership, callTimeout: 2000 })
  pinia.use(runtime.plugin)
  createApp({}).use(pinia)
  setActivePinia(pinia)
  const store = useMemoryStore()
  // Cache the window-local ownership while this context's URL is selected.
  expect(store.isLeader).toBe(leadership === 'leader-only')
  contexts.push({ pinia, runtime })
  return { store, runtime }
}

afterEach(async () => {
  for (const item of contexts.splice(0)) {
    item.runtime.dispose()
    disposePinia(item.pinia)
  }
  await useDuckDb().closeDb()
  localStorage.clear()
  history.replaceState(null, '', originalUrl)
})

describe('memory interaction settings across windows', () => {
  // ROOT CAUSE:
  // V3 restores API embedding preferences but omits credentials. Every new
  // follower runs the source watcher, whose async validation error publishes
  // a full default snapshot before that follower receives the leader state.
  // Source: docs/fork/memory-v3-retest-20261029.md (two independent restores).
  it('keeps restored switches when a follower validates missing embedding credentials (V3)', async () => {
    localStorage.clear()
    localStorage.setItem('settings/memory/embedding-source', 'api')
    localStorage.setItem('settings/memory/embedding-model', 'voyage-4-large')
    const namespace = `memory-api-restore:${crypto.randomUUID()}`
    const leader = context(namespace, 'leader-only')
    await leader.store.setInteractionSettings({ directoryEnabled: true, toolsEnabled: true })
    await leader.store.initialize()
    await vi.waitFor(() => expect(leader.store.embeddingError).toContain('API key'))
    await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
    const follower = context(namespace, 'follower-only')
    const directWrites: string[] = []
    follower.store.$subscribe((mutation) => {
      if (mutation.type === 'direct')
        directWrites.push(mutation.type)
    }, { flush: 'sync' })
    await follower.store.initialize()
    await vi.waitFor(() => expect(follower.store.embeddingError).toContain('API key'))
    await vi.waitFor(() => expect(follower.runtime.getLeaderId()).toBe(leader.runtime.participantId))
    await vi.waitFor(() => expect(follower.store.toolsEnabled).toBe(true))
    expect(leader.store.toolsEnabled).toBe(true)
    expect(leader.store.directoryEnabled).toBe(true)
    expect(localStorage.getItem('settings/memory/tools-enabled')).toBe('true')
    expect(directWrites).toEqual([])
  })

  it('keeps leader database health when a follower validates missing embedding credentials (V3)', async () => {
    localStorage.clear()
    localStorage.setItem('settings/memory/enabled', 'true')
    localStorage.setItem('settings/memory/embedding-source', 'api')
    const namespace = `memory-api-health:${crypto.randomUUID()}`
    const leader = context(namespace, 'leader-only')
    await leader.store.setInteractionSettings({ directoryEnabled: true, toolsEnabled: true })
    await leader.store.initialize()
    expect(leader.store.toolsEnabled).toBe(true)
    expect(leader.store.databaseStatus).toBe('ready')
    await vi.waitFor(() => expect(leader.store.embeddingError).toContain('API key'))
    for (let round = 0; round < 3; round++) {
      const follower = context(namespace, 'follower-only')
      const writes: string[] = []
      follower.store.$subscribe((mutation) => {
        if (mutation.type === 'direct')
          writes.push(mutation.type)
      }, { flush: 'sync' })
      await follower.store.initialize()
      await vi.waitFor(() => expect(follower.store.embeddingError).toContain('API key'))
      await vi.waitFor(() => expect(follower.runtime.getLeaderId()).toBe(leader.runtime.participantId))
      await vi.waitFor(() => expect(follower.store.databaseStatus).toBe('ready'))
      expect(leader.store.databaseStatus).toBe('ready')
      expect(follower.store.toolsEnabled).toBe(true)
      expect(writes).toEqual([])
      follower.runtime.dispose()
    }
    const scope = { userId: 'local', characterId: 'restored' }
    const operation = await leader.store.proposeOperation({
      scope,
      sessionId: 'restore-health',
      turnId: 'restore-health-turn',
      sourceContext: { sessionId: 'restore-health', messageId: 'restore-health-turn', neighbors: [] },
      isCurrent: () => true,
    }, 'restore-health-operation', { kind: 'remember', content: 'Review this restored memory.' })
    expect(operation.status).toBe('pending_review')
  }, 60_000)

  // Restore can start before leader election. Exercise that startup ordering
  // without replacing the real synchronization runtime.
  it('restores settings during leader startup and keeps later followers in sync (V3)', async () => {
    localStorage.clear()
    const namespace = `memory-restore:${crypto.randomUUID()}`
    const leader = context(namespace, 'leader-only')
    localStorage.setItem('settings/memory/directory-enabled', 'true')
    localStorage.setItem('settings/memory/tools-enabled', 'true')
    await leader.store.restorePersistedSettings()
    await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
    const follower = context(namespace, 'follower-only')
    await vi.waitFor(() => expect(follower.runtime.getLeaderId()).toBe(leader.runtime.participantId))
    await vi.waitFor(() => expect(follower.store.toolsEnabled).toBe(true))
    expect(leader.store.directoryEnabled).toBe(true)
    expect(leader.store.toolsEnabled).toBe(true)
    expect(follower.store.directoryEnabled).toBe(true)
    expect(localStorage.getItem('settings/memory/tools-enabled')).toBe('true')
  })

  // ROOT CAUSE:
  // Follower initialize() changed databaseStatus in synchronized state before
  // its first snapshot arrived. That full-store proposal carried false flags
  // and replaced the leader's restored settings. Only the leader now writes
  // shared database health; follower initialization publishes no state.
  it('does not replace restored settings when a new follower initializes its database (V3)', async () => {
    localStorage.clear()
    const namespace = `memory-follower-start:${crypto.randomUUID()}`
    const leader = context(namespace, 'leader-only')
    await leader.store.setInteractionSettings({ directoryEnabled: true, toolsEnabled: true })
    let leaderChanges = 0
    leader.store.$subscribe(() => leaderChanges++, { flush: 'sync' })
    const follower = context(namespace, 'follower-only')
    await follower.store.initialize()
    await vi.waitFor(() => expect(follower.runtime.getLeaderId()).toBe(leader.runtime.participantId))
    await vi.waitFor(() => expect(follower.store.toolsEnabled).toBe(true))
    expect(leader.store.directoryEnabled).toBe(true)
    expect(leader.store.toolsEnabled).toBe(true)
    expect(follower.store.databaseStatus).toBe('idle')
    expect(leader.store.databaseStatus).toBe('idle')
    await follower.store.initialize()
    expect(leaderChanges).toBe(0)
    expect(localStorage.getItem('settings/memory/tools-enabled')).toBe('true')
  })

  it('does not persist a received snapshot, and routes follower changes to one leader', async () => {
    localStorage.clear()
    const namespace = `memory-settings:${crypto.randomUUID()}`
    const leader = context(namespace, 'leader-only')
    await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
    const follower = context(namespace, 'follower-only')
    await vi.waitFor(() => expect(follower.runtime.getLeaderId()).toBe(leader.runtime.participantId))
    let leaderChanges = 0
    let followerActions = 0
    leader.store.$subscribe(() => leaderChanges++, { flush: 'sync' })
    follower.store.$onAction(() => followerActions++)
    leader.store.$patch({ directoryEnabled: true, toolsEnabled: true })
    await vi.waitFor(() => expect(follower.store.toolsEnabled).toBe(true))
    expect(localStorage.getItem('settings/memory/tools-enabled')).toBeNull()
    expect(leaderChanges).toBe(1)
    expect(followerActions).toBe(0)
    await follower.store.setInteractionSettings({ directoryEnabled: true, toolsEnabled: false })
    await vi.waitFor(() => expect(follower.store.toolsEnabled).toBe(false))
    expect(leader.store.toolsEnabled).toBe(false)
    expect(localStorage.getItem('settings/memory/tools-enabled')).toBe('false')
  })
})

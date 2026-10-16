import type { PublicErrorCode } from '../../shared'
import type { SessionStore } from '../store/session'

/** A durable pose/state transition, not a claim that offline work happened. */
export function createSleep(options: { store: SessionStore; canSleep(): boolean; changed(): void }) {
  const set = (sleeping: boolean, cause: 'user' | 'day-end' | 'interaction', request?: { requestId: string; commandHash: string }): PublicErrorCode | undefined => {
    const unchanged = options.store.projection().sleeping === sleeping
    if (unchanged && !request) return
    if (sleeping && !unchanged && !options.canSleep()) return 'unavailable'
    options.store.append({ type: 'companion/sleep', sleeping, cause, ...request })
    options.changed()
  }
  return { set, wake: () => set(false, 'interaction') }
}
export type SleepService = ReturnType<typeof createSleep>

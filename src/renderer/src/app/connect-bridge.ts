import type { AppBridge, AppEvent, AppSnapshot } from '../../../shared'

/** Subscribe before snapshot; never overwrite a newer event with an older bootstrap reply. */
export function connectBridge(bridge: AppBridge, render: (snapshot: AppSnapshot) => void, onError: () => void) {
  let current: AppSnapshot | undefined
  let buffer: AppEvent[] = []
  let closed = false
  let loading = false
  let retry = false
  const apply = (snapshot: AppSnapshot) => { current = snapshot; render(snapshot) }
  const resync = async () => {
    if (closed || loading) return
    loading = true
    try {
      const snapshot = await bridge.getSnapshot()
      if (closed) return
      apply(snapshot)
      const queued = buffer
      buffer = []
      for (const event of queued) {
        if (event.epoch !== current!.epoch) { retry = true; continue }
        if (event.revision <= current!.revision) continue
        if (event.revision !== current!.revision + 1) { retry = true; continue }
        apply(event.snapshot)
      }
    } catch { if (!closed) onError() }
    finally {
      loading = false
      if (retry && !closed) { retry = false; void resync() }
    }
  }
  const unsubscribe = bridge.subscribe((event) => {
    if (closed) return
    if (loading || !current) {
      buffer.push(event)
      if (buffer.length > 256) { buffer = buffer.slice(-1); retry = true }
      if (!loading) void resync()
      return
    }
    if (event.epoch === current.epoch && event.revision <= current.revision) return
    if (event.epoch !== current.epoch || event.revision !== current.revision + 1) {
      buffer.push(event)
      void resync()
      return
    }
    apply(event.snapshot)
  })
  void resync()
  return () => { closed = true; buffer = []; unsubscribe() }
}

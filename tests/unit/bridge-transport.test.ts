import { describe, expect, it } from 'vitest'
import { createAppController } from '../../src/main/bridge/controller'
import { createManualClock } from '../../src/main/clock'
import { connectBridge } from '../../src/renderer/src/app/connect-bridge'
import type { AppBridge, AppEvent, AppSnapshot } from '../../src/shared'

describe('snapshot / event handoff', () => {
  it('buffers a newer event while bootstrap is pending and detaches cleanly', async () => {
    const snapshot = createAppController(createManualClock()).getSnapshot()
    const next = structuredClone(snapshot)
    next.revision = 1
    next.companion.mode = 'quiet'
    let complete!: (snapshot: AppSnapshot) => void
    let receive!: (event: AppEvent) => void
    let detached = false
    const bridge: AppBridge = {
      getSnapshot: () => new Promise((resolve) => { complete = resolve }),
      subscribe: (listener) => { receive = listener; return () => { detached = true } },
      dispatch: async (command) => ({ protocolVersion: 1, epoch: snapshot.epoch, requestId: command.requestId, status: 'rejected', error: { code: 'unavailable', retryable: false } }),
    }
    const rendered: AppSnapshot[] = []
    const disconnect = connectBridge(bridge, (value) => rendered.push(value), () => { throw new Error('unexpected transport error') })
    const event: AppEvent = { protocolVersion: 1, type: 'state.snapshot', reason: 'mode', epoch: next.epoch, revision: next.revision, occurredAtMs: 0, snapshot: next }
    receive(event)
    complete(snapshot)
    await Promise.resolve()
    expect(rendered.at(-1)?.companion.mode).toBe('quiet')
    disconnect()
    receive(event)
    expect(detached).toBe(true)
    expect(rendered.map((value) => value.revision)).toEqual([0, 1])
  })
})

import { expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createProbeResponseDeadline } from '../../scripts/fixtures/probe-response-deadline'
import { createWorldProbeStream } from '../../scripts/fixtures/world-probe-stream'
import plan from '../../scripts/continuity-live-plan.json'

const policy = plan.defaults.responseTimeouts
function setup() {
  const clock = createManualClock(1000), abort = new AbortController()
  const deadline = createProbeResponseDeadline(clock, policy, () => abort.abort())
  return { clock, abort, deadline }
}

it('allows the observed 65-second first response, then completes without a late timeout', () => {
  const { clock, abort, deadline } = setup()
  clock.advanceBy(65000); deadline.headers(); deadline.chunk(100)
  clock.advanceBy(2000); deadline.complete(); clock.advanceBy(policy.totalMs)
  expect(abort.signal.aborted).toBe(false)
  expect(deadline.diagnostics).toMatchObject({ headersMs: 65000, firstByteMs: 65000, completedMs: 67000, timeoutPhase: null })
})

it('does not let early headers or an empty chunk bypass the first-body deadline', () => {
  const { clock, abort, deadline } = setup()
  clock.advanceBy(100); deadline.headers(); deadline.chunk(0)
  clock.advanceBy(policy.firstResponseMs - 101); expect(abort.signal.aborted).toBe(false)
  clock.advanceBy(1); expect(abort.signal.aborted).toBe(true)
  expect(deadline.diagnostics).toMatchObject({ headersMs: 100, firstByteMs: null, timeoutPhase: 'first-response', timeoutMs: 120000 })
})

it('resets idle on received bytes and records a stalled stream separately from first response', () => {
  const { clock, abort, deadline } = setup()
  clock.advanceBy(65000); deadline.headers(); deadline.chunk(10)
  clock.advanceBy(59999); deadline.chunk(20)
  clock.advanceBy(59999); deadline.chunk(0); expect(abort.signal.aborted).toBe(false)
  clock.advanceBy(1); expect(abort.signal.aborted).toBe(true)
  expect(deadline.diagnostics).toMatchObject({ firstByteMs: 65000, lastByteMs: 124999, timeoutPhase: 'idle', timeoutMs: 184999 })
})

it('keeps the total cap even when bytes continue arriving', () => {
  const { clock, abort, deadline } = setup()
  for (let i = 0; i < 5; i++) { clock.advanceBy(50000); deadline.chunk(1) }
  clock.advanceBy(49999); expect(abort.signal.aborted).toBe(false)
  clock.advanceBy(1); expect(abort.signal.aborted).toBe(true)
  expect(deadline.diagnostics).toMatchObject({ timeoutPhase: 'total', timeoutMs: 300000 })
})

it('stops on a DONE sentinel without waiting for HTTP EOF or falsely reporting idle timeout', () => {
  const { clock, abort, deadline } = setup(), stream = createWorldProbeStream(() => {})
  clock.advanceBy(65000); deadline.headers()
  const data = 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  deadline.chunk(data.length); stream.push(data)
  expect(stream.terminalSentinelSeen()).toBe(true)
  stream.end(); deadline.complete(); clock.advanceBy(600000)
  expect(abort.signal.aborted).toBe(false)
  expect(deadline.diagnostics.completedMs).toBe(65000)
})

it('cancels timers on downstream shutdown without manufacturing a timeout', () => {
  const { clock, abort, deadline } = setup()
  clock.advanceBy(5000); deadline.stop(); deadline.stop(); clock.advanceBy(600000)
  expect(abort.signal.aborted).toBe(false)
  expect(deadline.diagnostics).toMatchObject({ timeoutPhase: null, completedMs: null })
})

it('times out only the stalled request when two requests share a clock', () => {
  const clock = createManualClock(), abortA = new AbortController(), abortB = new AbortController()
  const a = createProbeResponseDeadline(clock, policy, () => abortA.abort())
  const b = createProbeResponseDeadline(clock, policy, () => abortB.abort())
  clock.advanceBy(65000); b.chunk(1)
  clock.advanceBy(55000)
  expect(a.diagnostics.timeoutPhase).toBe('first-response')
  expect(abortA.signal.aborted).toBe(true); expect(abortB.signal.aborted).toBe(false)
  b.complete(); clock.advanceBy(600000); expect(abortB.signal.aborted).toBe(false)
})

it('rejects invalid policies and keeps outer scenario waits beyond individual requests', () => {
  const clock = createManualClock()
  for (const firstResponseMs of [0, -1, NaN, Infinity, 1.5, policy.totalMs + 1]) {
    expect(() => createProbeResponseDeadline(clock, { ...policy, firstResponseMs }, () => {})).toThrow('INVALID_PROBE_TIMEOUTS')
  }
  expect(plan.defaults.turnTimeoutMs).toBeGreaterThan(policy.totalMs)
  expect(plan.defaults.barrierTimeoutMs).toBeGreaterThanOrEqual(plan.defaults.turnTimeoutMs * 3)
})

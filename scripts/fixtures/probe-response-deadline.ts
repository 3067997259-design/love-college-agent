import type { Clock } from '../../src/main/clock'

export interface ProbeResponseTimeouts {
  firstResponseMs: number
  idleMs: number
  totalMs: number
}
type TimeoutPhase = 'first-response' | 'idle' | 'total'

/** Headers do not satisfy the first-body deadline. Bytes reset idle, never total. */
export function createProbeResponseDeadline(clock: Clock, policy: ProbeResponseTimeouts, abort: () => void) {
  if (Object.values(policy).some(ms => !Number.isSafeInteger(ms) || ms <= 0)
    || policy.totalMs < policy.firstResponseMs || policy.totalMs < policy.idleMs) throw Error('INVALID_PROBE_TIMEOUTS')
  const began = clock.nowMs()
  const diagnostics = {
    policy: { ...policy }, headersMs: null as number | null, firstByteMs: null as number | null,
    lastByteMs: null as number | null, completedMs: null as number | null,
    timeoutPhase: null as TimeoutPhase | null, timeoutMs: null as number | null,
  }
  let stopped = false, stopIdle: (() => void) | undefined
  const stop = () => { stopped = true; stopFirst(); stopTotal(); stopIdle?.() }
  const expire = (phase: TimeoutPhase) => {
    if (stopped) return
    diagnostics.timeoutPhase = phase; diagnostics.timeoutMs = clock.nowMs() - began
    stop(); abort()
  }
  const stopFirst = clock.after(policy.firstResponseMs, () => expire('first-response'))
  const stopTotal = clock.after(policy.totalMs, () => expire('total'))
  return {
    diagnostics,
    headers: () => { if (!stopped && diagnostics.headersMs === null) diagnostics.headersMs = clock.nowMs() - began },
    chunk: (bytes: number) => {
      if (stopped || bytes <= 0) return
      const elapsed = clock.nowMs() - began
      if (diagnostics.firstByteMs === null) { diagnostics.firstByteMs = elapsed; stopFirst() }
      diagnostics.lastByteMs = elapsed
      stopIdle?.(); stopIdle = clock.after(policy.idleMs, () => expire('idle'))
    },
    complete: () => { if (!stopped) { diagnostics.completedMs = clock.nowMs() - began; stop() } },
    stop,
  }
}

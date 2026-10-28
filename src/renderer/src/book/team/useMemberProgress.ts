import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../../shared'
import type { AgentView, MemberStepsRead } from '../../../../shared/collaboration'

/** Only display interpolation: main owns the phase, long-thinking threshold and station focus. */
export function useMemberElapsed(snapshot: AppSnapshot, member: AgentView): number {
  const [elapsed, setElapsed] = useState(0)
  const since = member.work?.sinceMs
  useEffect(() => {
    if (since === undefined) { setElapsed(0); return }
    const at = performance.now(), start = Math.max(0, snapshot.clock.nowMs - since)
    setElapsed(start)
    if (snapshot.clock.frozen) return
    let frame = 0, second = -1
    const tick = () => {
      const next = start + (performance.now() - at) * snapshot.clock.rate
      if (Math.floor(next / 1000) !== second) { second = Math.floor(next / 1000); setElapsed(next) }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [since, snapshot.clock.nowMs, snapshot.clock.frozen, snapshot.clock.rate, snapshot.epoch])
  return elapsed
}

/** Component-local details: unmount forgets them. At most one read per two real seconds, only after a step change. */
export function useMemberSteps(bridge: AppBridge, member: AgentView, epoch: string) {
  const address = JSON.stringify(member.address)
  const version = JSON.stringify([member.work?.phase, member.work?.templateId, member.work?.sinceMs, member.activity, member.outcome, member.sources.status, member.sources.kinds])
  const wanted = useRef(version); wanted.current = version
  const [answer, setAnswer] = useState<{ scope: string; value?: MemberStepsRead; failed?: boolean } | null>(null)
  const scope = `${epoch}:${address}`
  useEffect(() => {
    let closed = false, frame = 0, busy = false, readVersion: string | undefined, last = -Infinity
    setAnswer(null)
    const tick = () => {
      if (closed) return
      if (!busy && readVersion !== wanted.current && performance.now() - last >= 2000) {
        const requested = wanted.current
        readVersion = requested; last = performance.now(); busy = true
        const read = bridge.readMemberSteps?.(JSON.parse(address)) ?? Promise.reject(new Error('UNAVAILABLE'))
        void read.then((value) => { if (!closed && wanted.current === requested) setAnswer({ scope, value }) }, () => {
          if (!closed && wanted.current === requested) setAnswer({ scope, failed: true })
        }).finally(() => { busy = false })
      }
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => { closed = true; cancelAnimationFrame(frame) }
  }, [bridge, address, scope])
  const value = answer?.scope === scope ? answer.value : undefined
  // A fresh source restriction hides cached targets immediately, before the next IPC roundtrip.
  const withheld = member.sources.status !== 'clean' || value?.withheld === true
  return { value: value ? { ...value, withheld, steps: value.steps.map(({ target, ...step }) => ({ ...step, ...(!withheld && target ? { target } : {}) })) } : undefined,
    failed: answer?.scope === scope && answer.failed === true }
}
export const durationText = (ms: number) => ms < 60_000 ? `${Math.floor(Math.max(0, ms) / 1000)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.floor(ms / 1000) % 60} 秒`

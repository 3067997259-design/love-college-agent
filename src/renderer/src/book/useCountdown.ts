import { useEffect, useRef, useState } from 'react'
import type { AppSnapshot } from '../../../shared'

/**
 * 番茄钟的剩余时间：以快照为准，两次快照之间用 performance.now() 外推，
 * 只为了倒计时走得平滑。阶段切换、结束都以主进程的下一份快照为准，这里不判断。
 */
export function useCountdown(snapshot: AppSnapshot): number {
  const { pomodoro, clock } = snapshot
  const anchor = useRef({ at: performance.now(), remaining: pomodoro.remainingMs })
  const [remaining, setRemaining] = useState(pomodoro.remainingMs)

  useEffect(() => {
    anchor.current = { at: performance.now(), remaining: pomodoro.remainingMs }
    setRemaining(pomodoro.remainingMs)
    if (pomodoro.status !== 'running' || clock.frozen) return
    let frame = 0
    let last = -1
    const tick = () => {
      const elapsed = (performance.now() - anchor.current.at) * clock.rate
      const next = Math.max(0, anchor.current.remaining - elapsed)
      const shown = Math.ceil(next / 1000)
      if (shown !== last) { last = shown; setRemaining(next) }
      if (next > 0) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [pomodoro.remainingMs, pomodoro.status, clock.frozen, clock.rate, snapshot.revision, snapshot.epoch])

  return remaining
}

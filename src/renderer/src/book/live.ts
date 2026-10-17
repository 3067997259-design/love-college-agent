import { useRef } from 'react'

/**
 * 这次运行里亲眼看着变成这个值的（同一个 epoch 里从别的值变过来）。
 * 首个快照、重启、换 epoch（恢复存档、切场景）都不算：已经在那儿的东西只挂上，不重播“刚发生”的动画。
 */
export function useLiveFlip(epoch: string, value: string): boolean {
  const seen = useRef<{ epoch: string; value: string; live: boolean } | null>(null)
  if (!seen.current || seen.current.epoch !== epoch) seen.current = { epoch, value, live: false }
  else if (seen.current.value !== value) seen.current = { epoch, value, live: true }
  return seen.current.live
}

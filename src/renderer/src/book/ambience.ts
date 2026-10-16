import { useLayoutEffect, useRef } from 'react'
import type { CompanionView } from '../../../shared'

/**
 * 时段和熄灯挂在根元素上，设计 token 跟着切换（tokens.css）。书本和迷你窗共用。
 * 第一次显示直接到位，不从白天慢慢变暗；之后的切换才走平滑过渡。
 */
export function useRootAmbience(companion: Pick<CompanionView, 'daypart' | 'lightsOut'>) {
  const first = useRef(true)
  useLayoutEffect(() => {
    const root = document.documentElement
    if (first.current) root.style.transition = 'none'
    root.dataset.daypart = companion.daypart
    root.dataset.lightsOut = String(companion.lightsOut)
    if (first.current) {
      first.current = false
      void getComputedStyle(root).getPropertyValue('--paper') // 先让样式落定，再恢复过渡
      requestAnimationFrame(() => { root.style.transition = '' })
    }
  }, [companion.daypart, companion.lightsOut])
}

import { useLayoutEffect, useRef } from 'react'
import type { CompanionView } from '../../../shared'

type Light = Pick<CompanionView, 'daypart' | 'lightsOut'>

/**
 * 最近一次光线变化是不是拉灯：只换了 lightsOut、没换时段。拉灯是一下子的事，天色是慢慢变的。
 * 只看主进程给的 daypart 和 lightsOut，不从时间自己推。
 */
export function useLightSwitch(companion: Light): boolean {
  const last = useRef({ daypart: companion.daypart, lightsOut: companion.lightsOut, flip: false })
  const prev = last.current
  if (prev.daypart !== companion.daypart) last.current = { daypart: companion.daypart, lightsOut: companion.lightsOut, flip: false }
  else if (prev.lightsOut !== companion.lightsOut) last.current = { ...prev, lightsOut: companion.lightsOut, flip: true }
  return last.current.flip
}

/**
 * 时段和熄灯挂在根元素上，设计 token 跟着切换（tokens.css）。书本和迷你窗共用。
 * 第一次显示直接到位，不从白天慢慢变暗；之后的切换才走平滑过渡；拉灯走短过渡（data-light-switch）。
 */
export function useRootAmbience(companion: Light) {
  const first = useRef(true)
  const lightSwitch = useLightSwitch(companion)
  useLayoutEffect(() => {
    const root = document.documentElement
    if (first.current) root.style.transition = 'none'
    root.dataset.lightSwitch = String(lightSwitch)
    root.dataset.daypart = companion.daypart
    root.dataset.lightsOut = String(companion.lightsOut)
    if (first.current) {
      first.current = false
      void getComputedStyle(root).getPropertyValue('--paper') // 先让样式落定，再恢复过渡
      requestAnimationFrame(() => { root.style.transition = '' })
    }
  }, [companion.daypart, companion.lightsOut, lightSwitch])
}

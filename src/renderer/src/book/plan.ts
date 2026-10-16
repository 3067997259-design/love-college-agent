import type { PomodoroPlanInput, PomodoroView } from '../../../shared'

/**
 * 番茄计划的展示计算：只读快照，不推进任何状态。计时、阶段和“这一段算不算完成”都归主进程（技术方案 §3.5）。
 * 这里不用 DOM，单测直接引用。
 */
export type TomatoState = 'done' | 'active' | 'todo'

/** focusIndex 是已经开始过的专注段数：它之前的都做完了；它本身在专注里是“正在做”，到了休息或空闲就算做完 */
export function tomatoStates(pomodoro: PomodoroView): TomatoState[] {
  return Array.from({ length: pomodoro.plannedCount }, (_, i) => {
    const index = i + 1
    if (index < pomodoro.focusIndex || (index === pomodoro.focusIndex && pomodoro.phase !== 'focus')) return 'done'
    return index === pomodoro.focusIndex ? 'active' : 'todo'
  })
}

const MIN = 60_000

/** 20 秒 / 25 分钟 / 1 小时 55 分 */
export function formatSpan(ms: number): string {
  if (ms < MIN) return `${Math.round(ms / 1000)} 秒`
  const minutes = Math.round(ms / MIN)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`
}

/** 从第一个专注开始到最后一个专注结束：中间的休息算进去，最后那次休息不算 */
export function planSpanMs(plan: PomodoroPlanInput): number {
  let total = plan.plannedCount * plan.focusDurationMs
  for (let i = 1; i < plan.plannedCount; i++) total += i % plan.longBreakEvery === 0 ? plan.longBreakDurationMs : plan.shortBreakDurationMs
  return total
}

/** 演示节奏必须在界面上写明（src/shared/README.md） */
export function rhythmText(plan: PomodoroPlanInput): string {
  if (plan.timing === 'demo') return `演示节奏：专注 ${formatSpan(plan.focusDurationMs)}，休息 ${formatSpan(plan.shortBreakDurationMs)}`
  const long = plan.plannedCount >= plan.longBreakEvery ? `，每 ${plan.longBreakEvery} 个长休 ${formatSpan(plan.longBreakDurationMs)}` : ''
  return `专注 ${formatSpan(plan.focusDurationMs)}，短休 ${formatSpan(plan.shortBreakDurationMs)}${long}`
}

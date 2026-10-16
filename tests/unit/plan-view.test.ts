import { describe, expect, it } from 'vitest'
import type { PomodoroPlanInput, PomodoroView } from '../../src/shared'
import { formatSpan, planSpanMs, rhythmText, tomatoStates } from '../../src/renderer/src/book/plan'
import { SCENARIOS } from '../../src/renderer/src/dev/scenarios'

const standard: PomodoroPlanInput = {
  label: '专注计划', plannedCount: 4, focusDurationMs: 25 * 60_000, shortBreakDurationMs: 5 * 60_000,
  longBreakDurationMs: 15 * 60_000, longBreakEvery: 4, timing: 'standard',
}
const demo: PomodoroPlanInput = { ...standard, focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, timing: 'demo' }
const view = (patch: Partial<PomodoroView>): PomodoroView =>
  ({ phase: 'idle', status: 'idle', remainingMs: 0, endsAtMs: null, focusIndex: 0, phaseDurationMs: 0, plannedCount: 4, ...patch })

describe('pomodoro plan display', () => {
  it('marks tomatoes from the main-process focus index without deciding completion itself', () => {
    expect(tomatoStates(view({}))).toEqual(['todo', 'todo', 'todo', 'todo'])
    expect(tomatoStates(view({ phase: 'focus', status: 'running', focusIndex: 2 }))).toEqual(['done', 'active', 'todo', 'todo'])
    expect(tomatoStates(view({ phase: 'focus', status: 'paused', focusIndex: 2 }))).toEqual(['done', 'active', 'todo', 'todo'])
    expect(tomatoStates(view({ phase: 'short-break', status: 'running', focusIndex: 2 }))).toEqual(['done', 'done', 'todo', 'todo'])
    // 提前翻牌：主进程把这一段退回 focusIndex - 1，不算完成
    expect(tomatoStates(view({ phase: 'short-break', status: 'running', focusIndex: 1 }))).toEqual(['done', 'todo', 'todo', 'todo'])
    expect(tomatoStates(view({ focusIndex: 4 }))).toEqual(['done', 'done', 'done', 'done'])
    expect(tomatoStates(view({ plannedCount: 0 }))).toEqual([])
  })
  it('counts breaks between focuses but not the rest after the last one', () => {
    expect(planSpanMs(standard)).toBe((4 * 25 + 3 * 5) * 60_000)
    expect(planSpanMs({ ...standard, plannedCount: 5 })).toBe((5 * 25 + 3 * 5 + 15) * 60_000)
    expect(planSpanMs(demo)).toBe(4 * 60_000 + 3 * 20_000)
    expect(planSpanMs({ ...standard, plannedCount: 1 })).toBe(25 * 60_000)
  })
  it('writes spans and rhythm in plain Chinese and always labels the demo rhythm', () => {
    expect(formatSpan(20_000)).toBe('20 秒')
    expect(formatSpan(60_000)).toBe('1 分钟')
    expect(formatSpan(115 * 60_000)).toBe('1 小时 55 分')
    expect(formatSpan(120 * 60_000)).toBe('2 小时')
    expect(rhythmText(demo)).toBe('演示节奏：专注 1 分钟，休息 20 秒')
    expect(rhythmText(standard)).toBe('专注 25 分钟，短休 5 分钟，每 4 个长休 15 分钟')
    expect(rhythmText({ ...standard, plannedCount: 2 })).toBe('专注 25 分钟，短休 5 分钟')
  })
  it('keeps the plan scenes consistent with the main-process plan rules', () => {
    const proposed = SCENARIOS['plan-proposed'].pomodoro
    expect(proposed.plan).toBeUndefined()
    expect(proposed).toMatchObject({ phase: 'idle', status: 'idle', focusIndex: 0, proposal: { status: 'proposed', source: 'assistant', timing: 'demo' } })
    expect(proposed.proposal?.items?.reduce((sum, item) => sum + item.count, 0)).toBe(proposed.proposal?.plannedCount)
    for (const id of ['focus-working', 'break-delivery'] as const) {
      const { plan, plannedCount } = SCENARIOS[id].pomodoro
      expect(plan?.status).toBe('confirmed')
      expect(plan?.plannedCount).toBe(plannedCount)
    }
  })
})

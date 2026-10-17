import { describe, expect, it } from 'vitest'
import { easeInOut, ghostAlpha, LEAVE_COLOR_MS, LEAVE_TOTAL_MS, poseOf, transitionKind, washProgress } from '../../src/renderer/src/book/wash/wash-math'

describe('left page transitions', () => {
  it('clamps progress and treats zero duration as done', () => {
    expect(washProgress(-5, 1000)).toBe(0)
    expect(washProgress(500, 1000)).toBe(0.5)
    expect(washProgress(7000, 6000)).toBe(1)
    expect(washProgress(1, 0)).toBe(1)
  })
  it('repaints her only for same-lighting pose changes; expressions crossfade and light changes fade', () => {
    const a = (key: string, lighting: 'ambient' | 'baked-night' | 'baked-dark' = 'ambient') => ({ key, lighting })
    expect(poseOf('desk-writing_night')).toBe('desk-writing')
    expect(transitionKind(null, a('facing-user_calm'))).toBe('none')
    expect(transitionKind(a('facing-user_calm'), a('facing-user_calm'))).toBe('none')
    expect(transitionKind(a('facing-user_calm'), a('facing-user_smile'))).toBe('crossfade')
    expect(transitionKind(a('facing-user_smile'), a('desk-computer_calm'))).toBe('wash')
    // 天黑、睡着、醒来：整间屋都在变，不按剪影重画
    expect(transitionKind(a('desk-writing_calm'), a('desk-writing_night', 'baked-night'))).toBe('fade')
    expect(transitionKind(a('desk-writing_night', 'baked-night'), a('sleeping_nightlight', 'baked-night'))).toBe('fade')
    expect(transitionKind(a('sleeping_nightlight', 'baked-night'), a('facing-user_calm'))).toBe('fade')
    // 拉灯：一下子
    expect(transitionKind(a('sleeping_nightlight', 'baked-night'), a('sleeping_dark', 'baked-dark'))).toBe('crossfade')
    expect(transitionKind(a('desk-writing_night', 'baked-night'), a('desk-writing_calm'), true)).toBe('crossfade')
    // 出门、回来
    expect(transitionKind(a('desk-writing_calm'), a('empty'))).toBe('leave')
    expect(transitionKind(a('empty'), a('facing-user_smile'))).toBe('arrive')
    expect(transitionKind(a('empty'), a('sleeping_nightlight', 'baked-night'))).toBe('fade')
  })
  it('lets her pencil ghost surface, hold while her colour leaves, then fade out', () => {
    expect(ghostAlpha(0)).toBe(0)
    expect(ghostAlpha(125)).toBeCloseTo(0.5, 5)
    expect(ghostAlpha(500)).toBe(1)
    expect(ghostAlpha(LEAVE_COLOR_MS)).toBe(1)
    expect(ghostAlpha(LEAVE_TOTAL_MS)).toBe(0)
    expect(easeInOut(0.5)).toBe(0.5)
  })
})

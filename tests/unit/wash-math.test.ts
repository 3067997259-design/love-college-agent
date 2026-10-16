import { describe, expect, it } from 'vitest'
import { poseOf, transitionKind, washProgress } from '../../src/renderer/src/book/wash/wash-math'

describe('left page transitions', () => {
  it('clamps progress and treats zero duration as done', () => {
    expect(washProgress(-5, 1000)).toBe(0)
    expect(washProgress(500, 1000)).toBe(0.5)
    expect(washProgress(7000, 6000)).toBe(1)
    expect(washProgress(1, 0)).toBe(1)
  })
  it('repaints her only when the pose changes; expressions and lighting crossfade', () => {
    expect(poseOf('desk-writing_night')).toBe('desk-writing')
    expect(transitionKind(null, 'facing-user_calm')).toBe('none')
    expect(transitionKind('facing-user_calm', 'facing-user_calm')).toBe('none')
    expect(transitionKind('facing-user_calm', 'facing-user_smile')).toBe('crossfade')
    expect(transitionKind('desk-writing_calm', 'desk-writing_night')).toBe('crossfade')
    expect(transitionKind('facing-user_smile', 'desk-computer_calm')).toBe('wash')
    expect(transitionKind('desk-writing_calm', 'empty')).toBe('wash')
  })
})

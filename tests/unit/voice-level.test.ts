import { describe, expect, it } from 'vitest'
import { mouthOf, smoothLevel, voiceLevel } from '../../src/renderer/src/voice/level'

describe('voice level and mouth signal', () => {
  it('opens quickly, closes slowly and settles at zero', () => {
    expect(smoothLevel(0, 0.5)).toBe(0.5)
    const closing = smoothLevel(0.5, 0)
    expect(closing).toBeGreaterThan(0.3)
    expect(closing).toBeLessThan(0.5)
    expect(smoothLevel(0.004, 0)).toBe(0)
    expect(smoothLevel(0, 7)).toBe(1)
  })
  it('maps loudness to closed, half and open mouth shapes', () => {
    expect(mouthOf(0)).toBe('closed')
    expect(mouthOf(0.1)).toBe('half')
    expect(mouthOf(0.6)).toBe('open')
  })
  it('notifies subscribers and resets to a closed mouth', () => {
    const seen: string[] = []
    const off = voiceLevel.subscribe((_level, mouth) => seen.push(mouth))
    voiceLevel.set(0.8); voiceLevel.reset(); off(); voiceLevel.set(0.8)
    expect(seen).toEqual(['open', 'closed'])
    voiceLevel.reset()
  })
})

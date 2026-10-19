import { describe, expect, it } from 'vitest'
import { attentionAllowsLife, createAttention, deriveAttention } from '../../src/main/attention/service'
import type { AttentionInputs } from '../../src/main/attention/service'

const base: AttentionInputs = { mode: 'rest', lightsOut: false, sleeping: false, userTurn: false, taskComputing: false,
  taskWaiting: false, giftMaking: false, lifeActive: false, focusRunning: false }

describe('D3 attention precedence', () => {
  it('keeps rest above everything while lights are out or she is sleeping', () => {
    expect(deriveAttention({ ...base, lightsOut: true, userTurn: true })).toMatchObject({ kind: 'rest', pose: 'sleeping' })
    expect(deriveAttention({ ...base, sleeping: true, taskComputing: true })).toMatchObject({ kind: 'rest', pose: 'sleeping' })
  })
  it('orders user talk above task computing, gift and her own work', () => {
    expect(deriveAttention({ ...base, userTurn: true, taskComputing: true, giftMaking: true, lifeActive: true })).toMatchObject({ kind: 'user', pose: 'facing-user' })
    expect(deriveAttention({ ...base, taskComputing: true, giftMaking: true, lifeActive: true })).toMatchObject({ kind: 'task', pose: 'desk-computer' })
    expect(deriveAttention({ ...base, giftMaking: true, lifeActive: true })).toMatchObject({ kind: 'gift', pose: 'desk-writing' })
    expect(deriveAttention({ ...base, lifeActive: true })).toMatchObject({ kind: 'life', pose: 'desk-writing' })
  })
  it('does not let a task waiting for the user occupy her own time', () => {
    const waiting = deriveAttention({ ...base, taskWaiting: true })
    expect(waiting).toMatchObject({ kind: 'idle', taskWaiting: true })
    expect(attentionAllowsLife(waiting)).toBe(true)
    const hers = deriveAttention({ ...base, taskWaiting: true, lifeActive: true })
    expect(hers).toMatchObject({ kind: 'life', taskWaiting: true })
    expect(attentionAllowsLife(hers)).toBe(true)
    expect(attentionAllowsLife(deriveAttention({ ...base, taskComputing: true }))).toBe(false)
    expect(attentionAllowsLife(deriveAttention({ ...base, userTurn: true }))).toBe(false)
  })
  it('derives idle pose from the interaction mode and exposes the same answer through the service', () => {
    expect(deriveAttention({ ...base, mode: 'work' })).toMatchObject({ kind: 'idle', pose: 'desk-computer' })
    expect(deriveAttention({ ...base, mode: 'quiet' })).toMatchObject({ kind: 'idle', pose: 'desk-writing' })
    const service = createAttention({ inputs: () => ({ ...base, lifeActive: true }) })
    expect(service.view()).toMatchObject({ kind: 'life' })
    expect(service.lifeAllowed()).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createAppController } from '../../src/main/bridge/controller'
import { createManualClock } from '../../src/main/clock'
import { deriveDaypart } from '../../src/main/clock/daypart'
import { createUserEvidenceReader } from '../../src/main/bridge/evidence'
import { DEFAULT_EXPRESSION, EXPRESSION_IDS, POSE_IDS } from '../../src/shared'

describe('Claude UI contract additions', () => {
  it('publishes known slots and calculates daypart on the main clock with routine boundaries', () => {
    expect(EXPRESSION_IDS).toEqual(['calm', 'smile', 'think', 'worried'])
    expect(POSE_IDS).toContain('desk-writing')
    const clock = createManualClock(Date.UTC(2026, 9, 16, 8, 59))
    const controller = createAppController(clock)
    expect(controller.getSnapshot().companion).toMatchObject({ expression: DEFAULT_EXPRESSION, daypart: 'day', mailboxUnseen: 0 })
    controller.start()
    clock.advanceBy(60_000)
    expect(controller.getSnapshot().companion.daypart).toBe('evening')
    controller.dispose()
    expect(deriveDaypart(Date.UTC(2026, 9, 16, 13), { morningStartHour: 7, dayStartHour: 12, eveningStartHour: 18, nightStartHour: 22 })).toBe('evening')
  })
  it('keeps evidence in a separate scoped reader and rejects paths and invalid highlights', async () => {
    const scope = { userId: 'u', characterId: 'c', sessionId: 's' }
    const entry = { subject: '虚构通知', senderName: '课程助教', receivedAtMs: 1, excerpt: '周五提交', highlights: [{ start: 0, end: 2, field: 'deadlineIso' }] }
    const lookup = vi.fn(async () => entry)
    const read = createUserEvidenceReader(lookup)
    await expect(read('mail:1', scope)).resolves.toEqual(entry)
    expect(lookup).toHaveBeenCalledWith('mail:1', scope)
    await expect(read('../secrets/providers.json', scope)).rejects.toThrow('EVIDENCE_INVALID_REFERENCE')
    expect(lookup).toHaveBeenCalledTimes(1)
    await expect(createUserEvidenceReader()( 'mail:1', scope)).rejects.toThrow('EVIDENCE_UNAVAILABLE')
    await expect(createUserEvidenceReader(async () => ({ ...entry, highlights: [{ start: 0, end: 9999, field: 'title' }] }))('mail:1', scope)).rejects.toThrow('EVIDENCE_UNAVAILABLE')
  })
})

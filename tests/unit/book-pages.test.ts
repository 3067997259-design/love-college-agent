import { describe, expect, it } from 'vitest'
import type { LifeWorkItem, MessageView } from '../../src/shared'
import { visibleWorks } from '../../src/renderer/src/book/sheets/schedule'
import { quoteOnPage, type Quote } from '../../src/renderer/src/book/history/quote'

const job = (id: string, dayKey: string, status: LifeWorkItem['status']): LifeWorkItem => ({
  id, dayKey, kind: 'read', source: 'fake', materialId: 'm', status, completedSteps: 1, totalSteps: 3, createdAtMs: 0, updatedAtMs: 0, completedAtMs: null,
})
const work = (jobs: LifeWorkItem[]) => ({ enabled: true, source: 'fake' as const, runningId: null, attemptsToday: 0, dailyAttemptLimit: 4, materials: [], jobs })
const message = (id: string, text: string): MessageView => ({ id, role: 'assistant', text, createdAtMs: 0, status: 'complete' })

describe('book pages', () => {
  it('keeps every unfinished work from earlier days visible after a cross-day restart (GitHub #18)', () => {
    const jobs = [job('old-interrupted', '2026-10-16', 'interrupted'), job('old-done', '2026-10-16', 'completed'), job('old-failed', '2026-10-16', 'failed'),
      job('old-queued', '2026-10-16', 'queued'), job('today-done', '2026-10-17', 'completed'), job('today-failed', '2026-10-17', 'failed')]
    expect(visibleWorks({ dayKey: '2026-10-17', work: work(jobs) }).map((item) => item.id)).toEqual(['old-interrupted', 'old-failed', 'old-queued', 'today-done', 'today-failed'])
    expect(visibleWorks(undefined)).toEqual([])
  })
  it('only lets a selection quote a recallable line on the loaded page whose text still matches (GitHub #19)', () => {
    const quote: Quote = { anchor: { sessionId: 'day-A', messageId: 'm1', start: 0, end: 3 }, text: '周五桥', dayKey: '2026-10-15' }
    const pageA = { sessionId: 'day-A', messages: [message('m1', '周五桥是蓝色的'), message('m2', '另一句')], recallableMessageIds: ['m1'] }
    expect(quoteOnPage(quote, pageA)).toBe(quote)
    expect(quoteOnPage(quote, { ...pageA, sessionId: 'day-B' })).toBeNull()
    expect(quoteOnPage(quote, null)).toBeNull()
    expect(quoteOnPage(null, pageA)).toBeNull()
    expect(quoteOnPage(quote, { ...pageA, recallableMessageIds: ['m2'] })).toBeNull()
    expect(quoteOnPage(quote, { ...pageA, messages: [message('m1', '周六桥是蓝色的')] })).toBeNull()
  })
})

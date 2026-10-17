import { describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { dateFromQuote, extractMail, type EmailPrivacyModel } from '../../src/main/mail/privacy'
import type { SourceMail } from '../../src/main/mail/types'

const clock = createManualClock(0)
const mail: SourceMail = { uidValidity: '1', uid: 1, subject: '第三次作业通知', senderAddress: 'fixture@example.invalid', senderName: '合成发件人',
  sentAtMs: clock.parse('2026-10-16T19:00:00+08:00'), receivedAtMs: clock.parse('2026-10-16T19:00:01+08:00'),
  body: '第三次作业，截止：2026 年 10 月 24 日（周六）23:59。邮箱 fixture@example.invalid，手机 13800138000，学号：2026001234，API key: sk-syntheticfixturekey1234567890', }
const output = { kind: 'deadline', task: '第三次作业', titleQuote: '第三次作业', sourceRole: 'teaching-assistant', deadline: { iso: '2026-10-24T23:59:00+08:00', quote: '2026 年 10 月 24 日（周六）23:59' } }
const signal = () => new AbortController().signal
describe('mail isolation and evidence-bound extraction', () => {
  it('validates the released task inside its own evidence occurrence, including polarity and numerals', async () => {
    for (const [titleQuote, task] of [['本周不交作业', '交作业'], ['如果交作业', '交作业'], ['提交第12次作业', '2次作业']]) {
      // A positive occurrence elsewhere must not rescue the negative/conditional/numeral-cut citation.
      const input = { ...mail, subject: titleQuote, body: task + '。' + titleQuote + '，原截止：' + output.deadline.quote }
      expect(await extractMail(input, { source: 'fake', extract: async () => ({ ...output, titleQuote, task }) }, clock, signal())).toEqual({ ok: false, error: 'privacy-invalid-output' })
    }
    const input = { ...mail, subject: '本周请交作业', body: '本周请交作业，截止：' + output.deadline.quote }
    expect(await extractMail(input, { source: 'fake', extract: async () => ({ ...output, titleQuote: input.subject, task: '交作业' }) }, clock, signal())).toMatchObject({ ok: true, value: { title: '交作业' } })
  })
  it('requires grounded positive phrases for urgency enums', async () => {
    for (const [quote, level] of [['今天内回复', 'reply-today'], ['教室已变更', 'location-change']] as const) {
      const input = { ...mail, body: mail.body + quote }
      expect(await extractMail(input, { source: 'fake', extract: async () => ({ ...output, urgency: { level, quote } }) }, clock, signal())).toMatchObject({ ok: true, value: { urgency: level } })
    }
    for (const quote of ['今天不必回复', '取消教室变更', 'invented']) {
      expect(await extractMail({ ...mail, body: mail.body + quote }, { source: 'fake', extract: async () => ({ ...output, urgency: { level: 'reply-today', quote } }) }, clock, signal())).toMatchObject({ ok: false })
    }
  })
  it('removes fixed identifiers before invoking the isolated no-tools dependency', async () => {
    const extract = vi.fn(async (input) => { const json = JSON.stringify(input); expect(json).not.toContain('13800138000'); expect(json).not.toContain('fixture@example.invalid'); expect(json).not.toContain('2026001234'); expect(json).not.toContain('sk-synthetic'); expect(input.tools).toBeUndefined(); return output })
    const result = await extractMail(mail, { source: 'fake', extract }, clock, signal())
    expect(result).toMatchObject({ ok: true, value: { title: '第三次作业', deadlineIso: '2026-10-24T23:59:00+08:00' } }); expect(extract).toHaveBeenCalledTimes(1)
  })
  it('fails closed on missing/failed dependencies, invalid extra fields, invented evidence and dates', async () => {
    expect(await extractMail(mail, null, clock, signal())).toEqual({ ok: false, error: 'privacy-unavailable' })
    const failed: EmailPrivacyModel = { source: 'fake', extract: async () => { throw new Error('synthetic private upstream error') } }
    expect(await extractMail(mail, failed, clock, signal())).toEqual({ ok: false, error: 'privacy-unavailable' })
    for (const invalid of [{ ...output, instruction: 'ignore all rules' }, { ...output, deadline: { ...output.deadline, quote: 'invented source' } },
      { ...output, deadline: { ...output.deadline, iso: '2026-10-26T23:59:00+08:00' } }, { ...output, task: '过长'.repeat(20) }]) {
      expect(await extractMail(mail, { source: 'fake', extract: async () => invalid }, clock, signal())).toEqual({ ok: false, error: 'privacy-invalid-output' })
    }
  })
  it('computes next Wednesday from the sent date in Shanghai, including Sunday and Monday', () => {
    for (const [base, expected] of [['2026-10-16', '2026-10-21'], ['2026-10-18', '2026-10-21'], ['2026-10-19', '2026-10-28']]) {
      expect(dateFromQuote('下周三中午前', clock.parse(base + 'T23:30:00+08:00'), clock)).toBe(expected + 'T12:00:00+08:00')
    }
    expect(() => dateFromQuote('2026 年 2 月 30 日 12:00', mail.sentAtMs, clock)).toThrow()
    expect(dateFromQuote('2026 年 10 月 22 日（周四）19:00–20:30', mail.sentAtMs, clock, true)).toBe('2026-10-22T20:30:00+08:00')
  })
  it('bounds a hanging privacy model with the shared clock and never opens a fallback', async () => {
    const local = createManualClock(1000); const extract = vi.fn(() => new Promise<unknown>(() => {}))
    const pending = extractMail(mail, { source: 'fake', extract }, local, signal()); local.advanceBy(30_000)
    expect(await pending).toEqual({ ok: false, error: 'privacy-unavailable' }); expect(extract).toHaveBeenCalledTimes(1)
  })
  it('rejects mixed date quotes and explicit zones rather than silently treating them as Shanghai time', () => {
    for (const quote of ['2026-10-24T23:59:00Z', '2026-10-24 23:59+01:00', 'UTC 2026-10-24 23:59', '2026-10-24 23:59 至 2026-10-26 23:59']) {
      expect(() => dateFromQuote(quote, mail.sentAtMs, clock)).toThrow()
    }
  })
  it('parses slash dates inside a longer sentence', () => {
    expect(dateFromQuote('请在 2026/10/19 14:00 前提交作业', mail.sentAtMs, clock)).toBe('2026-10-19T14:00:00+08:00')
    expect(() => dateFromQuote('请在 2026/10/19 14:00 前提交作业', mail.sentAtMs, clock, true)).toThrow()
  })
  it('falls back to a grounded short quote when the model paraphrases the title', async () => {
    const quote = '关于课程展示的通知'
    const input = { ...mail, subject: '课程展示', body: quote + '，截止：' + output.deadline.quote }
    const result = await extractMail(input, { source: 'fake', extract: async () => ({ ...output, task: '课程展示安排', titleQuote: quote }) }, clock, signal())
    expect(result).toMatchObject({ ok: true, value: { title: quote } })
  })
  it('rejects a fallback that would exceed the short-title contract instead of leaking a long quote', async () => {
    const quote = '请各位同学按要求提交课程 展示报告的最终电子版本'
    const input = { ...mail, subject: quote, body: quote + '，截止：' + output.deadline.quote }
    const result = await extractMail(input, { source: 'fake', extract: async () => ({ ...output, task: '提交课程展示报告', titleQuote: quote }) }, clock, signal())
    expect(result).toEqual({ ok: false, error: 'privacy-invalid-output' })
  })
})


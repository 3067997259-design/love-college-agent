import { describe, expect, it } from 'vitest'
import type { AppCommand } from '../../src/shared'
import { createManualClock } from '../../src/main/clock'
import { extractMail } from '../../src/main/mail/privacy'
import type { SourceMail } from '../../src/main/mail/types'
import { validateMemories } from '../../src/main/memory/model'
import { groundingVerdict, groundedIn } from '../../src/main/memory/grounding'
import type { SeenFragment } from '../../src/main/memory/seen'

const owner = { userId: 'u', characterId: 'c' }
const fragment = (text: string, origin: SeenFragment['origin'] = 'user'): SeenFragment => ({ id: 'f1', key: 'k1', sessionId: 's1', frameSeq: 2, index: 0, offset: 0, atMs: 1000, role: 'user', origin, text, source: text })
const extraction = (quote: string, kind: 'fact' | 'experience' = 'fact') => ({ items: [{ sourceId: 'f1', quote, kind, topic: '报告', replaceTopic: false }] })

describe('grounding: a substring is not an entailment', () => {
  it('rejects a quote whose negation was left outside the span', () => {
    const source = '老师说今天不用交实验报告'
    expect(groundedIn(source, '交实验报告').entailed).toBe(false)
    expect(() => validateMemories(extraction('交实验报告'), [fragment(source)], owner, [])).toThrow()
  })
  it('rejects a quote sliced out of a numeral', () => {
    expect(groundedIn('截止时间是12月13日晚上八点', '3日晚上八点').entailed).toBe(false)
    expect(groundedIn('这门课不少于5页', '5页').entailed).toBe(false)
  })
  it('rejects material under a conditional or a non-factive operator', () => {
    expect(groundedIn('如果下雨才改到周日', '改到周日').entailed).toBe(false)
    expect(groundedIn('有同学问是不是改到三楼', '改到三楼').entailed).toBe(false)
    expect(groundedIn('听说明天停课', '明天停课').entailed).toBe(false)
  })
  it('accepts a quote whose negator sits in an attributive modifier, not over the predicate', () => {
    const source = '没选修实验课的同学不用管，选了的同学周五提交报告'
    expect(groundedIn(source, '周五提交报告').entailed).toBe(true)
    expect(groundedIn('还不清楚格式的同学请先下载模板', '先下载模板').entailed).toBe(true)
  })
  it('keeps double negation affirmative', () => {
    expect(groundedIn('并非不需要提交预习报告', '需要提交预习报告').entailed).toBe(true)
    expect(groundedIn('不能不参加安全培训', '参加安全培训').entailed).toBe(true)
  })
  it('accepts a complete sentence and a plain statement unchanged', () => {
    expect(groundedIn('请在下周三前提交实验报告', '下周三前提交实验报告').entailed).toBe(true)
    expect(groundedIn('报告已经交给教务处了', '报告已经交给教务处了').entailed).toBe(true)
  })
  it('refuses a span that is not the text it claims', () => {
    expect(groundingVerdict('报告下周交', '下周交', 0, 3).reason).toBe('not-a-substring')
  })
  it('refuses a span that keeps the front of a clause and drops the predicate after the boundary', () => {
    expect(groundedIn('报告下周交，地点改到三楼', '下周交，地点').entailed).toBe(false)
    // The same sentence quoted whole stays acceptable.
    expect(groundedIn('报告下周交，地点改到三楼', '下周交，地点改到三楼').entailed).toBe(true)
  })
})

describe('grounding reaches the two real extraction paths', () => {
  it('rejects a negated quote in the memory extraction path', () => {
    expect(() => validateMemories(extraction('提交报告'), [fragment('我没有提交报告。')], owner, [])).toThrow()
    // The plain affirmation still passes.
    expect(validateMemories(extraction('提交报告'), [fragment('我提交报告了。')], owner, [])).toHaveLength(1)
  })
  it('rejects a mail task whose negation was stripped, not merely contained', async () => {
    const clock = createManualClock(0)
    // The narrow exit grounds the title against subject + body. A model that quotes only the predicate
    // must be refused, because the sentence negates it; quoting the whole clause stays acceptable.
    const mail: SourceMail = { uidValidity: '1', uid: 1, subject: '本周不交作业', senderAddress: 'fixture@example.invalid', senderName: '合成发件人',
      sentAtMs: clock.parse('2026-10-16T19:00:00+08:00'), receivedAtMs: 0, body: '合成。本周不交作业，截止：2026 年 10 月 24 日 23:59' }
    const source = mail.subject + '\n' + mail.body
    // Quoting the negated clause is faithful; starting the quote after the negator is not.
    expect(groundedIn(source, '不交作业').entailed).toBe(true)
    expect(groundedIn(source, '交作业').entailed).toBe(false)
    const result = await extractMail(mail, { source: 'fake', extract: async () => ({ kind: 'deadline', task: '交作业', titleQuote: '交作业', sourceRole: 'teaching-assistant', deadline: { iso: '2026-10-24T23:59:00+08:00', quote: '2026 年 10 月 24 日 23:59' } }) }, clock, new AbortController().signal)
    expect(result.ok).toBe(false)
  })
  it('still accepts an ordinary grounded mail task', async () => {
    const clock = createManualClock(0)
    const mail: SourceMail = { uidValidity: '1', uid: 2, subject: '普通作业', senderAddress: 'fixture@example.invalid', senderName: '合成发件人',
      sentAtMs: clock.parse('2026-10-16T19:00:00+08:00'), receivedAtMs: 0, body: '合成。普通作业，截止：2026 年 10 月 24 日 23:59' }
    const quote = '2026 年 10 月 24 日 23:59'
    const result = await extractMail(mail, { source: 'fake', extract: async () => ({ kind: 'deadline', task: '普通作业', titleQuote: '普通作业', sourceRole: 'teaching-assistant', deadline: { iso: '2026-10-24T23:59:00+08:00', quote } }) }, clock, new AbortController().signal)
    expect(result.ok).toBe(true)
    void ({} as AppCommand)
  })
})

import { z } from 'zod'
import type { EvidenceView } from '../../shared'
import type { Clock } from '../clock'
import { redactFixed } from '../privacy/redact'
import type { SourceMail } from './types'

const short = (length: number) => z.string().trim().min(1).max(length).refine((text) => [...text].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
  && !/https?:\/\/|<\/?(?:system|assistant|tool)[ >]|\b(?:api_key|authorization)\b/i.test(text) && redactFixed(text) === text)
const quote = z.string().min(1).max(300).refine((text) => redactFixed(text) === text)
const date = z.strictObject({ iso: z.iso.datetime({ offset: true }), quote })
const action = z.strictObject({ kind: z.enum(['deadline', 'event']), task: short(20), titleQuote: quote,
  sourceRole: z.enum(['teaching-assistant', 'student-club', 'library', 'other']), deadline: date.nullable(),
  eventStart: date.optional(), eventEnd: date.optional(), location: z.strictObject({ text: short(40), quote }).optional(),
})
const schema = z.union([z.strictObject({ kind: z.literal('notice') }), action])
export interface EmailPrivacyInput { sourceId: string; subject: string; body: string; sentAtIso: string }
export interface EmailPrivacyModel { readonly source: 'real' | 'fake'; extract(input: EmailPrivacyInput, signal: AbortSignal): Promise<unknown> }
export interface CheckedMail {
  kind: 'deadline' | 'event'; title: string; sourceRole: z.infer<typeof action>['sourceRole']; deadlineIso: string | null
  eventStartIso?: string; eventEndIso?: string; locationText?: string
  /** User-only provenance, removed before journal/model projections. */
  quotes: { field: EvidenceView['highlights'][number]['field']; text: string }[]
}
const pad = (value: number) => String(value).padStart(2, '0')
function canonical(year: number, month: number, day: number, hour: number, minute: number, clock: Clock) {
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`
  const ms = clock.parse(iso)
  if (!Number.isFinite(ms) || clock.iso(ms + 8 * 60 * 60_000).slice(0, 19) !== iso.slice(0, 19)) throw new Error('MAIL_DATE_INVALID')
  return iso
}
/** Supported expressions are explicit dates or next-calendar-week weekdays. Unsupported language rejects. */
export function dateFromQuote(text: string, sentAtMs: number, clock: Clock, end = false): string {
  const explicit = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*[（(][^）)]*[）)])?\s*(\d{1,2}):(\d{2})/)
    ?? text.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/)
  if (explicit) {
    const dates = text.match(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{2}-\d{2}/g) ?? []
    if (dates.length !== 1) throw new Error('MAIL_DATE_AMBIGUOUS')
    // This parser accepts Shanghai-local expressions only. Never silently discard an explicit zone.
    const suffix = text.slice((explicit.index ?? 0) + explicit[0].length)
    if (/^\s*(?::\d{2})?\s*(?:Z\b|[+-]\d{2}:?\d{2})|\b(?:UTC|GMT)\b/i.test(suffix) || /\b(?:UTC|GMT)\b/i.test(text)) throw new Error('MAIL_ZONE_UNSUPPORTED')
    let hour = Number(explicit[4]); let minute = Number(explicit[5])
    if (end) {
      const tail = text.slice((explicit.index ?? 0) + explicit[0].length).match(/^\s*[–—-]\s*(\d{1,2}):(\d{2})/)
      if (!tail) throw new Error('MAIL_END_UNSUPPORTED')
      hour = Number(tail[1]); minute = Number(tail[2])
    }
    return canonical(Number(explicit[1]), Number(explicit[2]), Number(explicit[3]), hour, minute, clock)
  }
  const relative = text.match(/下周([一二三四五六日天])(?:\s*(中午|晚上|上午|下午))?(?:\s*(\d{1,2}):(\d{2}))?/)
  if (!relative || end) throw new Error('MAIL_DATE_UNSUPPORTED')
  const day = clock.iso(sentAtMs + 8 * 60 * 60_000).slice(0, 10)
  const base = clock.parse(day + 'T00:00:00Z')
  const mondayIndex = ((Math.floor(base / 86_400_000) + 4) % 7 + 6) % 7
  const targetDay = '一二三四五六日'.indexOf(relative[1] === '天' ? '日' : relative[1])
  const target = clock.iso(base + (7 - mondayIndex + targetDay) * 86_400_000).slice(0, 10)
  if (!relative[3] && relative[2] !== '中午') throw new Error('MAIL_TIME_UNSUPPORTED')
  let hour = relative[3] ? Number(relative[3]) : 12
  if (relative[2] === '下午' || relative[2] === '晚上') hour = hour < 12 ? hour + 12 : hour
  return canonical(Number(target.slice(0, 4)), Number(target.slice(5, 7)), Number(target.slice(8)), hour, Number(relative[4] ?? 0), clock)
}

export async function extractMail(mail: SourceMail, model: EmailPrivacyModel | null, clock: Clock, signal: AbortSignal): Promise<
  { ok: true; value: CheckedMail | null } | { ok: false; error: 'privacy-unavailable' | 'privacy-invalid-output' }
> {
  if (!model || signal.aborted) return { ok: false, error: 'privacy-unavailable' }
  if (mail.body.length > 64_000 || mail.subject.length > 256 || !Number.isFinite(mail.sentAtMs)) return { ok: false, error: 'privacy-invalid-output' }
  const local = new AbortController(); const combined = AbortSignal.any([signal, local.signal])
  let removeAbort = () => {}
  const cancel = clock.after(30_000, () => local.abort())
  let output: unknown
  try {
    const abort = new Promise<never>((_resolve, reject) => {
      const listener = () => reject(new Error('PRIVACY_ABORTED'))
      combined.addEventListener('abort', listener, { once: true }); removeAbort = () => combined.removeEventListener('abort', listener)
      if (combined.aborted) listener()
    })
    output = await Promise.race([model.extract({ sourceId: `${mail.uidValidity}:${mail.uid}`, subject: redactFixed(mail.subject), body: redactFixed(mail.body), sentAtIso: clock.iso(mail.sentAtMs) }, combined), abort])
  } catch { return { ok: false, error: 'privacy-unavailable' } }
  finally { cancel(); removeAbort() }
  if (combined.aborted) return { ok: false, error: 'privacy-unavailable' }
  try {
    const parsed = schema.parse(output)
    if (parsed.kind === 'notice') return { ok: true, value: null }
    const source = mail.subject + '\n' + mail.body
    const quotes: CheckedMail['quotes'] = []
    if (!source.includes(parsed.titleQuote) || !parsed.titleQuote.includes(parsed.task)) throw new Error('MAIL_TITLE_UNGROUNDED')
    quotes.push({ field: 'title', text: parsed.task })
    const checkedDate = (value: z.infer<typeof date> | undefined | null, field: 'deadlineIso' | 'eventStartIso' | 'eventEndIso') => {
      if (!value) return undefined
      if (!source.includes(value.quote)) throw new Error('MAIL_EVIDENCE_UNGROUNDED')
      const verified = dateFromQuote(value.quote, mail.sentAtMs, clock, field === 'eventEndIso')
      if (clock.parse(verified) !== clock.parse(value.iso)) throw new Error('MAIL_DATE_MISMATCH')
      quotes.push({ field, text: value.quote }); return verified
    }
    const deadlineIso = checkedDate(parsed.deadline, 'deadlineIso') ?? null
    const eventStartIso = checkedDate(parsed.eventStart, 'eventStartIso'); const eventEndIso = checkedDate(parsed.eventEnd, 'eventEndIso')
    if (parsed.kind === 'deadline' && !deadlineIso) throw new Error('MAIL_DEADLINE_REQUIRED')
    if (parsed.kind === 'event' && !eventStartIso) throw new Error('MAIL_EVENT_REQUIRED')
    if (eventEndIso && (!eventStartIso || clock.parse(eventEndIso) <= clock.parse(eventStartIso))) throw new Error('MAIL_EVENT_RANGE_INVALID')
    if (parsed.location) {
      if (!source.includes(parsed.location.quote) || !parsed.location.quote.includes(parsed.location.text)) throw new Error('MAIL_LOCATION_UNGROUNDED')
      quotes.push({ field: 'locationText', text: parsed.location.text })
    }
    return { ok: true, value: { kind: parsed.kind, title: parsed.task, sourceRole: parsed.sourceRole, deadlineIso,
      ...(eventStartIso ? { eventStartIso } : {}), ...(eventEndIso ? { eventEndIso } : {}), ...(parsed.location ? { locationText: parsed.location.text } : {}), quotes } }
  } catch { return { ok: false, error: 'privacy-invalid-output' } }
}

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { EvidenceView, Scope } from '../../shared'
import { redactFixed } from '../privacy/redact'
import type { CampusProjection } from '../campus/projection'
import type { CheckedMail } from './privacy'
import type { SourceMail } from './types'

const sourceSchema = z.strictObject({ uidValidity: z.string().regex(/^\d{1,20}$/), uid: z.number().int().positive().max(4_294_967_295), senderAddress: z.string().min(1).max(320), senderName: z.string().max(80),
  subject: z.string().max(256), body: z.string().max(64_000), sentAtMs: z.number().int().nonnegative(), receivedAtMs: z.number().int().nonnegative() })
const quotesSchema = z.array(z.strictObject({ field: z.enum(['deadlineIso', 'eventStartIso', 'eventEndIso', 'locationText', 'title']), text: z.string().min(1).max(300) })).max(10)
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const mailContentHash = (mail: SourceMail) => digest(JSON.stringify(sourceSchema.parse(mail)))

/** Presentation is user-only. Fixed-pattern credentials remain hidden even in this separate view. */
export function evidenceView(mail: SourceMail, quotes: CheckedMail['quotes']): EvidenceView {
  const body = redactFixed(mail.body); const subject = redactFixed(mail.subject)
  let excerpt = body
  if (excerpt.length > 8000) {
    const spans = quotes.flatMap((quote) => { const start = body.indexOf(quote.text); return start < 0 ? [] : [{ start: Math.max(0, start - 150), end: Math.min(body.length, start + quote.text.length + 150) }] }).sort((a, b) => a.start - b.start)
    const merged: { start: number; end: number }[] = []
    for (const span of spans) { const last = merged.at(-1); if (last && span.start <= last.end) last.end = Math.max(last.end, span.end); else merged.push(span) }
    excerpt = merged.map((span) => body.slice(span.start, span.end)).join('\n…\n').slice(0, 8000) || body.slice(0, 8000)
  }
  const highlights = quotes.flatMap((quote) => { const start = excerpt.indexOf(quote.text); return start < 0 ? [] : [{ start, end: start + quote.text.length, field: quote.field }] })
  return { subject, senderName: redactFixed(mail.senderName), receivedAtMs: mail.receivedAtMs, excerpt, highlights }
}
export interface EvidenceVault {
  put(sourceKey: string, mail: SourceMail, quotes: CheckedMail['quotes']): string
  read(ref: string, scope: Scope): EvidenceView
  cache(state: CampusProjection, count: number): void
  close(): void
}
export function openEvidenceVault(root: string, owner: Pick<Scope, 'userId' | 'characterId'>): EvidenceVault {
  const db = new Database(join(root, 'campus.sqlite')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL')
  db.exec(`CREATE TABLE IF NOT EXISTS private_mail_evidence (owner TEXT NOT NULL, ref TEXT NOT NULL, content_hash TEXT NOT NULL, source_key TEXT NOT NULL, payload TEXT NOT NULL, quotes TEXT NOT NULL, PRIMARY KEY(owner,ref));
    CREATE TABLE IF NOT EXISTS campus_projections (owner TEXT PRIMARY KEY, record_count INTEGER NOT NULL, state_json TEXT NOT NULL);`)
  const ownerKey = digest(JSON.stringify([owner.userId, owner.characterId]))
  const insert = db.prepare('INSERT OR IGNORE INTO private_mail_evidence VALUES (?,?,?,?,?,?)')
  const read = db.prepare('SELECT payload,quotes,content_hash,source_key FROM private_mail_evidence WHERE owner=? AND ref=?')
  return {
    put: (sourceKey, mail, quotes) => {
      const payload = JSON.stringify(sourceSchema.parse(mail)); const verified = quotesSchema.parse(quotes)
      const hash = digest(payload); const ref = 'e:' + digest(ownerKey + sourceKey + hash + JSON.stringify(verified))
      db.transaction(() => insert.run(ownerKey, ref, hash, sourceKey, payload, JSON.stringify(verified)))()
      return ref
    },
    read: (ref, scope) => {
      if (scope.userId !== owner.userId || scope.characterId !== owner.characterId || !/^e:[a-f0-9]{64}$/.test(ref)) throw new Error('EVIDENCE_UNAVAILABLE')
      const row = read.get(ownerKey, ref) as { payload: string; quotes: string; content_hash: string; source_key: string } | undefined
      if (!row) throw new Error('EVIDENCE_UNAVAILABLE')
      if (digest(row.payload) !== row.content_hash || 'e:' + digest(ownerKey + row.source_key + row.content_hash + row.quotes) !== ref) throw new Error('EVIDENCE_UNAVAILABLE')
      return evidenceView(sourceSchema.parse(JSON.parse(row.payload)), quotesSchema.parse(JSON.parse(row.quotes)))
    },
    cache: (state, count) => { db.prepare('INSERT INTO campus_projections VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET record_count=excluded.record_count,state_json=excluded.state_json').run(ownerKey, count, JSON.stringify(state)) },
    close: () => db.close(),
  }
}

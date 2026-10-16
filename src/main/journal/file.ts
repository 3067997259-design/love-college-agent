import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Clock } from '../clock'
import type { Scope } from '../../shared'
import { inputSchema, parseRecord, type JournalInput, type JournalRecord } from './schema'

export interface Journal {
  readonly scope: Scope
  records(): readonly JournalRecord[]
  append(input: JournalInput): JournalRecord
  close(): void
}

export function sessionDayKey(clock: Clock, atMs = clock.nowMs()) { return clock.iso(atMs + 4 * 60 * 60 * 1000).slice(0, 10) }
export function journalLocation(dataDir: string, owner: Pick<Scope, 'userId' | 'characterId'>, clock: Clock) {
  const ownerKey = createHash('sha256').update(JSON.stringify([owner.userId, owner.characterId])).digest('hex')
  return { folder: join(dataDir, 'journals', ownerKey), dayKey: sessionDayKey(clock) }
}

export function parseJournalContent(content: string, owner: Pick<Scope, 'userId' | 'characterId'>): JournalRecord[] {
  if (content && !content.endsWith('\n')) throw new Error('JOURNAL_INCOMPLETE')
  const records = content ? content.slice(0, -1).split('\n').map((line) => parseRecord(JSON.parse(line))) : []
  for (let index = 0; index < records.length; index++) {
    if (records[index].seq !== index + 1 || (index > 0 && records[index].type === 'session/header')) throw new Error('JOURNAL_CORRUPT')
  }
  const header = records[0]
  if (header && (header.type !== 'session/header' || header.userId !== owner.userId || header.characterId !== owner.characterId)) throw new Error('JOURNAL_SCOPE_MISMATCH')
  return records
}

/** One Electron owner per data directory; journal fsync precedes every projection write. */
export function openJournal(dataDir: string, owner: Pick<Scope, 'userId' | 'characterId'>, clock: Clock): Journal {
  const { folder, dayKey } = journalLocation(dataDir, owner, clock)
  mkdirSync(folder, { recursive: true })
  // Shanghai local day starting at 04:00; runtime owner decides when it is safe to rotate.
  const fd = openSync(join(folder, `${dayKey}.jsonl`), 'a+')
  let closed = false
  let poisoned = false
  let bytes = fstatSync(fd).size
  let records: JournalRecord[]
  try {
    records = parseJournalContent(readFileSync(fd, 'utf8'), owner)
  } catch { closeSync(fd); throw new Error('JOURNAL_READ_FAILED') }
  const append = (input: JournalInput): JournalRecord => {
    if (closed || poisoned) throw new Error('JOURNAL_NOT_WRITABLE')
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success || (records.length > 0 && input.type === 'session/header')) throw new Error('JOURNAL_INVALID_EVENT')
    if (input.type === 'context/compact' && (input.fromSeq <= 1 || input.toSeq < input.fromSeq || input.toSeq > records.length)) throw new Error('JOURNAL_INVALID_RANGE')
    const record: JournalRecord = { ...parsed.data, version: 1, seq: records.length + 1, atMs: clock.nowMs() }
    const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8')
    if (line.length > 2 * 1024 * 1024) throw new Error('JOURNAL_EVENT_TOO_LARGE')
    try {
      if (fstatSync(fd).size !== bytes) throw new Error('JOURNAL_CHANGED')
      let offset = 0
      while (offset < line.length) {
        const written = writeSync(fd, line, offset, line.length - offset)
        if (written <= 0) throw new Error('JOURNAL_WRITE_FAILED')
        offset += written
      }
      fsyncSync(fd)
      bytes += line.length
      records.push(record)
      return structuredClone(record)
    } catch { poisoned = true; throw new Error('JOURNAL_WRITE_FAILED') }
  }
  if (records.length === 0) {
    try { append({ type: 'session/header', ...owner, sessionId: randomUUID() }) }
    catch { closeSync(fd); throw new Error('JOURNAL_WRITE_FAILED') }
  }
  const header = records[0] as Extract<JournalRecord, { type: 'session/header' }>
  return {
    scope: Object.freeze({ ...owner, sessionId: header.sessionId }),
    records: () => structuredClone(records), append,
    close: () => { if (!closed) { closed = true; closeSync(fd) } },
  }
}

export function commandHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

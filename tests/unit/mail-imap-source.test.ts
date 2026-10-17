import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createImapSource, type ImapClientLike } from '../../src/main/mail/imap'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach((run) => run()))
const mailFile = () => {
  const root = mkdtempSync(join(tmpdir(), 'lca-imap-source-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'providers.json')
  writeFileSync(file, JSON.stringify({ providers: {}, mail: { host: 'imap.example.test', port: 993, tls: true, user: 'student@example.test', auth_code: 'synthetic-auth-code', folder: '桃子' } }))
  return file
}
const rawMail = (subject: string, body: string, attachment = false) => [
  'From: TA <ta@example.test>', 'To: student@example.test', `Subject: ${subject}`, 'Date: Fri, 17 Oct 2026 10:00:00 +0800', 'MIME-Version: 1.0',
  attachment ? 'Content-Type: multipart/mixed; boundary="b"' : 'Content-Type: text/plain; charset=utf-8', '',
  ...(attachment ? ['--b', 'Content-Type: text/plain; charset=utf-8', '', body, '--b', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="brief.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--b--', ''] : [body, '']),
].join('\r\n')
function fakeClient(messages: readonly { uid: number; raw: string; internalDate?: Date }[], options: { readOnly?: boolean; failOnOpen?: boolean; hangSearch?: boolean } = {}): ImapClientLike & EventEmitter & { loggedOut: boolean } {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    loggedOut: false,
    mailbox: { readOnly: options.readOnly ?? true, uidValidity: 7 },
    async connect() {},
    async getMailboxLock() { if (options.failOnOpen) throw new Error('IMAP_OPEN_FAILED'); return { release() {} } },
    async search() { if (options.hangSearch) return new Promise<number[]>(() => {}); return messages.map((message) => message.uid) },
    async fetchOne(uid: number) { const found = messages.find((message) => message.uid === uid); return found ? { uid, internalDate: found.internalDate ?? new Date('2026-10-17T02:00:00Z'), source: Buffer.from(found.raw) } : undefined },
    async logout() { this.loggedOut = true },
    close() {},
  })
}

describe('read-only IMAP source', () => {
  it('maps unseen messages, sender, subject, body, timestamps and attachments without writing flags', async () => {
    const file = mailFile()
    const client = fakeClient([
      { uid: 1, raw: rawMail('课程展示安排', '课程展示：10 月 19 日 14:00，信息楼 302。') },
      { uid: 2, raw: rawMail('带附件', '请查收附件。', true) },
    ])
    const source = createImapSource(file, createManualClock(1_000_000), { createClient: () => client })
    const batch = await source.readUnseen(new AbortController().signal)
    expect(source.blocked).toBe(false); expect(batch.unseenCount).toBe(2); expect(batch.messages).toHaveLength(2); expect(batch.skipped).toBe(0)
    expect(batch.messages[0]).toMatchObject({ uid: 1, uidValidity: '7', senderAddress: 'ta@example.test', senderName: 'TA', subject: '课程展示安排' })
    expect(batch.messages[0].body).toContain('信息楼 302')
    expect(batch.messages[1].attachments?.[0]).toMatchObject({ partId: '1', format: 'pdf' }); expect(batch.messages[1].attachments?.[0].byteLength).toBeGreaterThan(0)
    expect(Buffer.from(await source.readAttachment!({ uidValidity: '7', uid: 2, partId: '1' }, new AbortController().signal)).toString()).toContain('%PDF')
    expect(client.loggedOut).toBe(true)
  })

  it('keeps a subject-and-attachment-only mail instead of dropping it with an empty body', async () => {
    const client = fakeClient([{ uid: 1, raw: rawMail('作业说明', '', true) }])
    const source = createImapSource(mailFile(), createManualClock(1_000_000), { createClient: () => client })
    const batch = await source.readUnseen(new AbortController().signal)
    expect(batch.messages).toHaveLength(1); expect(batch.messages[0].body).toBe(''); expect(batch.messages[0].attachments).toHaveLength(1)
  })

  it('silently ignores a completely empty mail without attachment', async () => {
    const client = fakeClient([{ uid: 1, raw: rawMail('空邮件', '') }])
    const source = createImapSource(mailFile(), createManualClock(1_000_000), { createClient: () => client })
    const batch = await source.readUnseen(new AbortController().signal)
    expect(batch.messages).toHaveLength(0); expect(batch.skipped).toBe(0); expect(batch.unseenCount).toBe(1)
  })

  it('skips an oversized message but keeps independent messages in the same batch', async () => {
    const client = fakeClient([
      { uid: 1, raw: rawMail('超长邮件', 'x'.repeat(64_001)) },
      { uid: 2, raw: rawMail('正常待办', '10 月 19 日 14:00 截止。') },
    ])
    const source = createImapSource(mailFile(), createManualClock(1_000_000), { createClient: () => client })
    const batch = await source.readUnseen(new AbortController().signal)
    expect(batch.unseenCount).toBe(2); expect(batch.messages).toHaveLength(1); expect(batch.messages[0].uid).toBe(2); expect(batch.skipped).toBe(1)
  })

  it('re-fetches an attachment after a new source instance loses the in-memory cache', async () => {
    const file = mailFile(); const client = fakeClient([{ uid: 2, raw: rawMail('带附件', '请查收附件。', true) }])
    const first = createImapSource(file, createManualClock(1_000_000), { createClient: () => client })
    const batch = await first.readUnseen(new AbortController().signal)
    expect(batch.messages[0].attachments?.[0].partId).toBe('1')
    const second = createImapSource(file, createManualClock(1_000_000), { createClient: () => client })
    const bytes = await second.readAttachment!({ uidValidity: '7', uid: 2, partId: '1' }, new AbortController().signal)
    expect(Buffer.from(bytes).toString()).toContain('%PDF')
  })

  it('rejects a mailbox that is not opened read-only', async () => {
    const client = fakeClient([{ uid: 1, raw: rawMail('x', 'y') }], { readOnly: false })
    const source = createImapSource(mailFile(), createManualClock(1_000_000), { createClient: () => client })
    await expect(source.readUnseen(new AbortController().signal)).rejects.toThrow('MAILBOX_NOT_READONLY')
  })

  it('fails closed when the configured folder cannot be opened', async () => {
    const client = fakeClient([], { failOnOpen: true })
    const source = createImapSource(mailFile(), createManualClock(1_000_000), { createClient: () => client })
    await expect(source.readUnseen(new AbortController().signal)).rejects.toThrow('IMAP_OPEN_FAILED')
  })

  it('turns an async socket error into a rejected read instead of escaping the main process', async () => {
    const client = fakeClient([], { hangSearch: true })
    const source = createImapSource(mailFile(), createManualClock(1_000_000), { createClient: () => client })
    const pending = source.readUnseen(new AbortController().signal)
    await new Promise((done) => setTimeout(done, 10))
    client.emit('error', new Error('ECONNRESET'))
    await expect(pending).rejects.toThrow('IMAP_CONNECTION_LOST')
  })

  it('caps the batch and rejects an aborted read before connecting', async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ uid: index + 1, raw: rawMail('m' + index, 'body ' + index) }))
    const source = createImapSource(mailFile(), createManualClock(1_000_000), { createClient: () => fakeClient(many) })
    const batch = await source.readUnseen(new AbortController().signal)
    expect(batch.unseenCount).toBe(40); expect(batch.messages).toHaveLength(30)
    const aborted = new AbortController(); aborted.abort()
    await expect(source.readUnseen(aborted.signal)).rejects.toThrow()
  })
})

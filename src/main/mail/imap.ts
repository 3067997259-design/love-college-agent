import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { readMailCredentials, type MailCredentials } from '../config/providers'
import type { Clock } from '../clock'
import type { MailSource, SourceMail } from './types'

/** Bounded read-only adapter for the configured folder. It never writes flags, opens other folders, or exposes credentials/body to callers other than the privacy pipeline. */
const MAX_MESSAGES = 30
const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const LIMITS = { senderAddress: 320, senderName: 80, subject: 256, body: 64_000 }
type AttachmentPart = { partId: string; format: 'pdf' | 'text' | 'markdown'; byteLength: number; bytes: Uint8Array }

const attachmentFormat = (contentType: string | undefined, filename: string | undefined): 'pdf' | 'text' | 'markdown' | undefined => {
  const name = (filename ?? '').toLowerCase()
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'pdf'
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown'
  if (type.startsWith('text/') || name.endsWith('.txt')) return 'text'
  return undefined
}
const htmlToText = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim()
const textOf = (parsed: { text?: string; html?: string | false }): string => (parsed.text ?? (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '')).trim()
const attachmentParts = (parsed: { attachments?: readonly { contentType?: string; filename?: string; size: number; content: Buffer }[] }): AttachmentPart[] => {
  const parts: AttachmentPart[] = []
  for (const attachment of parsed.attachments ?? []) {
    if (parts.length >= MAX_ATTACHMENTS) break
    const format = attachmentFormat(attachment.contentType, attachment.filename)
    if (!format || attachment.size <= 0 || attachment.size > MAX_ATTACHMENT_BYTES) continue
    const bytes = new Uint8Array(attachment.content)
    parts.push({ partId: String(parts.length + 1), format, byteLength: bytes.length, bytes })
  }
  return parts
}
const timeOf = (value: unknown): number | undefined => {
  const date = value as { getTime?: () => number } | undefined
  return date && typeof date.getTime === 'function' ? date.getTime() : undefined
}

export interface ImapClientLike {
  on?(event: 'error', listener: (error: unknown) => void): void
  off?(event: 'error', listener: (error: unknown) => void): void
  connect(): Promise<void>
  getMailboxLock(path: string, options: { readOnly: true }): Promise<{ release(): void }>
  search(query: { seen: boolean }, options: { uid: true }): Promise<number[]>
  fetchOne(uid: number, query: { uid?: true; envelope?: true; internalDate?: true; source?: true }, options: { uid: true }): Promise<{ uid?: number; internalDate?: Date; source?: Buffer } | undefined>
  logout(): Promise<void>
  close(): void
  mailbox?: { readOnly?: boolean; uidValidity?: number | bigint } | null
}
export interface ImapSourceOptions { createClient?: (mail: MailCredentials) => ImapClientLike }

export function createImapSource(filename: string, clock: Clock, options: ImapSourceOptions = {}): MailSource {
  const cachedAttachments = new Map<string, Uint8Array>()
  const createClient = options.createClient ?? ((mail) => new ImapFlow({
    host: mail.host, port: mail.port, secure: mail.tls, auth: { user: mail.user, pass: mail.auth_code },
    clientInfo: { name: 'Love College Agent', version: '0.1.0' },
    logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true, disableBinary: true,
    ...(process.env.LCA_IMAP_PROXY ? { proxy: process.env.LCA_IMAP_PROXY } : {}),
    ...(process.env.LCA_IMAP_TLS12 === '1' ? { tls: { minVersion: 'TLSv1.2' as const, maxVersion: 'TLSv1.2' as const } } : {}),
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  }) as unknown as ImapClientLike)
  /** One read-only connection. Async socket errors become a rejected read instead of escaping the main process. */
  const withClient = async <T>(signal: AbortSignal, action: (client: ImapClientLike, uidValidity: string, credentials: MailCredentials) => Promise<T>): Promise<T> => {
    signal.throwIfAborted()
    const credentials = await readMailCredentials(filename)
    const client = createClient(credentials)
    let rejectFailure!: (error: Error) => void
    const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject })
    failure.catch(() => {})
    const onError = () => { rejectFailure(new Error('IMAP_CONNECTION_LOST')); try { client.close() } catch { /* already closed */ } }
    client.on?.('error', onError)
    const abort = () => { try { client.close() } catch { /* already closed */ } }
    signal.addEventListener('abort', abort, { once: true })
    let lock: { release(): void } | undefined
    try {
      const work = (async () => {
        await client.connect()
        signal.throwIfAborted()
        lock = await client.getMailboxLock(credentials.folder, { readOnly: true })
        if (!client.mailbox || client.mailbox.readOnly !== true) throw new Error('MAILBOX_NOT_READONLY')
        const uidValidity = String(client.mailbox.uidValidity ?? '')
        if (!/^\d{1,20}$/.test(uidValidity)) throw new Error('MAIL_UIDVALIDITY_INVALID')
        return await action(client, uidValidity, credentials)
      })()
      work.catch(() => {})
      return await Promise.race([work, failure])
    } finally {
      signal.removeEventListener('abort', abort)
      lock?.release()
      await client.logout().catch(() => {})
      try { client.close() } catch { /* already closed */ }
      client.off?.('error', onError)
    }
  }
  const toSourceMail = async (source: Buffer, uid: number, uidValidity: string, receivedDefault: number): Promise<{ mail?: SourceMail; skipped: boolean }> => {
    const parsed = await simpleParser(source)
    const body = textOf(parsed)
    const parts = attachmentParts(parsed)
    const from = parsed.from?.value?.[0]
    const senderAddress = from?.address?.trim() ?? ''
    const senderName = from?.name?.trim() ?? from?.address?.trim() ?? ''
    const subject = parsed.subject ?? ''
    if (senderAddress.length > LIMITS.senderAddress || senderName.length > LIMITS.senderName || subject.length > LIMITS.subject || body.length > LIMITS.body) return { skipped: true }
    // A subject/attachment-only mail is a valid message; only a completely empty mail without a usable attachment is ignored.
    if (!senderAddress || (!body && parts.length === 0)) return { skipped: false }
    const sentAtMs = timeOf(parsed.date) ?? receivedDefault
    const receivedAtMs = receivedDefault
    for (const part of parts) cachedAttachments.set(uidValidity + ':' + uid + ':' + part.partId, part.bytes)
    return { skipped: false, mail: {
      uidValidity, uid, senderAddress, senderName, subject, body,
      sentAtMs: Number.isFinite(sentAtMs) && sentAtMs >= 0 ? sentAtMs : clock.nowMs(),
      receivedAtMs: Number.isFinite(receivedAtMs) && receivedAtMs >= 0 ? receivedAtMs : clock.nowMs(),
      ...(parts.length ? { attachments: parts.map(({ partId, format, byteLength }) => ({ partId, format, byteLength })) } : {}),
    } }
  }
  return {
    source: 'real', blocked: false,
    async readUnseen(signal) {
      return withClient(signal, async (client) => {
        const uids = await client.search({ seen: false }, { uid: true })
        if (!Array.isArray(uids) || !uids.every((uid) => Number.isSafeInteger(uid) && uid > 0)) throw new Error('MAIL_SOURCE_INVALID')
        const messages: SourceMail[] = []; let skipped = 0
        for (const uid of uids.slice(-MAX_MESSAGES)) {
          signal.throwIfAborted()
          const item = await client.fetchOne(uid, { uid: true, envelope: true, internalDate: true, source: true }, { uid: true })
          if (!item || !item.source) { skipped++; continue }
          const mapped = await toSourceMail(item.source, uid, String(client.mailbox?.uidValidity ?? ''), timeOf(item.internalDate) ?? clock.nowMs())
          if (mapped.mail) messages.push(mapped.mail)
          if (mapped.skipped) skipped++
        }
        return { unseenCount: uids.length, messages, skipped }
      })
    },
    async readAttachment(mail, signal) {
      signal.throwIfAborted()
      const key = mail.uidValidity + ':' + mail.uid + ':' + mail.partId
      const cached = cachedAttachments.get(key); if (cached) return cached
      return withClient(signal, async (client, uidValidity) => {
        if (uidValidity !== mail.uidValidity) throw new Error('ATTACHMENT_UNAVAILABLE')
        const item = await client.fetchOne(mail.uid, { uid: true, source: true }, { uid: true })
        if (!item?.source) throw new Error('ATTACHMENT_UNAVAILABLE')
        const parsed = await simpleParser(item.source)
        const part = attachmentParts(parsed)[Number(mail.partId) - 1]
        if (!part) throw new Error('ATTACHMENT_UNAVAILABLE')
        cachedAttachments.set(key, part.bytes)
        return part.bytes
      })
    },
  }
}

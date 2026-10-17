import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { readMailCredentials, type MailCredentials } from '../config/providers'
import type { Clock } from '../clock'
import type { MailSource, SourceMail } from './types'

/** Bounded read-only adapter for the configured folder. It never writes flags, opens other folders, or exposes credentials/body to callers other than the privacy pipeline. */
const MAX_MESSAGES = 30
const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

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

export interface ImapClientLike {
  connect(): Promise<void>
  getMailboxLock(path: string, options: { readOnly: true }): Promise<{ release(): void }>
  search(query: { seen: boolean }, options: { uid: true }): Promise<number[]>
  fetchOne(uid: number, query: { uid?: true; envelope?: true; internalDate?: true; source?: true }, options: { uid: true }): Promise<{ uid?: number; internalDate?: Date; source?: Buffer } | false | undefined>
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
  }))
  return {
    source: 'real', blocked: false,
    async readUnseen(signal) {
      signal.throwIfAborted()
      const mail = await readMailCredentials(filename)
      const client = createClient(mail)
      const close = () => { try { client.close() } catch { /* already closed */ } }
      signal.addEventListener('abort', close, { once: true })
      let lock: { release(): void } | undefined
      try {
        await client.connect()
        signal.throwIfAborted()
        lock = await client.getMailboxLock(mail.folder, { readOnly: true })
        if (!client.mailbox || client.mailbox.readOnly !== true) throw new Error('MAILBOX_NOT_READONLY')
        const uidValidity = String(client.mailbox.uidValidity ?? '')
        if (!/^\d{1,20}$/.test(uidValidity)) throw new Error('MAIL_UIDVALIDITY_INVALID')
        const uids = await client.search({ seen: false }, { uid: true })
        if (!Array.isArray(uids) || !uids.every((uid) => Number.isSafeInteger(uid) && uid > 0)) throw new Error('MAIL_SOURCE_INVALID')
        const messages: SourceMail[] = []
        for (const uid of uids.slice(-MAX_MESSAGES)) {
          signal.throwIfAborted()
          const item = await client.fetchOne(uid, { uid: true, envelope: true, internalDate: true, source: true }, { uid: true })
          if (!item || !item.source) continue
          const parsed = await simpleParser(item.source)
          const body = textOf(parsed)
          if (!body) continue
          const from = parsed.from?.value?.[0]
          const internal = item.internalDate as unknown as { getTime?: () => number } | undefined
          const internalMs = internal && typeof internal.getTime === 'function' ? internal.getTime() : undefined
          const receivedAtMs = internalMs ?? parsed.date?.getTime() ?? clock.nowMs()
          const sentAtMs = parsed.date?.getTime() ?? receivedAtMs
          const attachments: { partId: string; format: 'pdf' | 'text' | 'markdown'; byteLength: number }[] = []
          for (const attachment of parsed.attachments ?? []) {
            if (attachments.length >= MAX_ATTACHMENTS) break
            const format = attachmentFormat(attachment.contentType, attachment.filename)
            if (!format || attachment.size <= 0 || attachment.size > MAX_ATTACHMENT_BYTES) continue
            const partId = String(attachments.length + 1)
            const bytes = new Uint8Array(attachment.content)
            cachedAttachments.set(uidValidity + ':' + uid + ':' + partId, bytes)
            attachments.push({ partId, format, byteLength: bytes.length })
          }
          messages.push({
            uidValidity, uid,
            senderAddress: from?.address ?? 'unknown@localhost', senderName: from?.name ?? from?.address ?? 'unknown',
            subject: parsed.subject ?? '(无主题)', body, sentAtMs, receivedAtMs,
            ...(attachments.length ? { attachments } : {}),
          })
        }
        return { unseenCount: uids.length, messages }
      } finally {
        signal.removeEventListener('abort', close)
        lock?.release()
        await client.logout().catch(() => {})
        close()
      }
    },
    async readAttachment(mail, signal) {
      signal.throwIfAborted()
      const bytes = cachedAttachments.get(mail.uidValidity + ':' + mail.uid + ':' + mail.partId)
      if (!bytes) throw new Error('ATTACHMENT_UNAVAILABLE')
      return bytes
    },
  }
}

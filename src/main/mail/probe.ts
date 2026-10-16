import { ImapFlow } from 'imapflow'
import { readMailCredentials } from '../config/providers'

function classifyFailure(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown'
  const detail = error as { code?: unknown; authenticationFailed?: unknown; message?: unknown }
  const code = typeof detail.code === 'string' ? detail.code : ''
  const message = typeof detail.message === 'string' ? detail.message : ''
  if (/unsafe login/i.test(message)) return 'unsafe-login'
  if (detail.authenticationFailed === true || /authentication|invalid credentials|login failed/i.test(message)) return 'authentication-rejected'
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns'
  if (/TLS|CERT|SSL/.test(code)) return 'tls'
  if (/TIMEOUT|ETIMEDOUT/.test(code)) return 'timeout'
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) return 'network'
  return 'unknown'
}

export async function probeImap(filename: string) {
  let stage: 'configuration' | 'connect' | 'open' | 'peek' | 'logout' = 'configuration'
  let client: ImapFlow | undefined
  try {
    const mail = await readMailCredentials(filename)
    client = new ImapFlow({
      host: mail.host, port: mail.port, secure: mail.tls, auth: { user: mail.user, pass: mail.auth_code },
      clientInfo: { name: 'Love College Agent', version: '0.1.0' },
      logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true, disableBinary: true,
      ...(process.env.LCA_IMAP_PROXY ? { proxy: process.env.LCA_IMAP_PROXY } : {}),
      ...(process.env.LCA_IMAP_TLS12 === '1' ? { tls: { minVersion: 'TLSv1.2' as const, maxVersion: 'TLSv1.2' as const } } : {}),
      connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    })
    client.on('error', () => { /* Fail closed; never print the error or connection object. */ })
    stage = 'connect'
    await client.connect()
    // connect() sends clientInfo using IMAP ID before any mailbox is opened.
    const idConfirmed = client.serverInfo !== null
    if (!idConfirmed) throw new Error('IMAP_ID_UNCONFIRMED')
    stage = 'open'
    const lock = await client.getMailboxLock(mail.folder, { readOnly: true })
    let peekVerified = false
    let flagsUnchanged = true
    let empty = true
    try {
      if (!client.mailbox || !client.mailbox.readOnly) throw new Error('MAILBOX_NOT_READONLY')
      empty = client.mailbox.exists === 0
      if (!empty) {
        stage = 'peek'
        const before = await client.fetchOne('*', { uid: true, flags: true })
        if (!before) throw new Error('MESSAGE_UNAVAILABLE')
        const peek = await client.fetchOne(before.uid, { source: { start: 0, maxLength: 1 } }, { uid: true })
        peekVerified = Boolean(peek && peek.source)
        const after = await client.fetchOne(before.uid, { flags: true }, { uid: true })
        if (!after) throw new Error('MESSAGE_UNAVAILABLE')
        flagsUnchanged = JSON.stringify([...(before.flags ?? [])].sort()) === JSON.stringify([...(after.flags ?? [])].sort())
        if (!peekVerified || !flagsUnchanged) throw new Error('PEEK_CHECK_FAILED')
      }
    } finally { lock.release() }
    stage = 'logout'
    await client.logout()
    return { ok: true, probe: 'imap', idConfirmed, readOnly: true, empty, peekVerified, flagsUnchanged }
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    const code = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'EConnectionClosed', 'ClosedAfterConnectTLS'].find((item) => item === rawCode) ?? 'UNCLASSIFIED'
    const authenticated = Boolean(client?.authenticated)
    const idConfirmed = client?.serverInfo != null
    client?.close()
    return { ok: false, probe: 'imap', stage, error: 'IMAP_PROBE_FAILED', reason: classifyFailure(error), code, authenticated, idConfirmed }
  }
}

import type { MailScenarioId } from '../../shared'
import type { Clock } from '../clock'
import type { EmailPrivacyModel } from './privacy'
import type { MailSource } from './types'
import fixture from './fixtures.json'
import { syntheticPdf } from '../documents/fixtures'

export function createFakeMailbox(clock: Clock) {
  let scenario: MailScenarioId = 'initial'
  const ids: Record<MailScenarioId, number[]> = { initial: [1, 2, 4], 'deadline-change': [1, 2, 3, 4], malicious: [99], 'privacy-failure': [98], empty: [] }
  const source: MailSource = { source: 'fake', blocked: false, readUnseen: async (signal) => {
    signal.throwIfAborted()
    const messages = fixture.messages.filter((message) => ids[scenario].includes(message.uid)).map((message) => ({ uid: message.uid, uidValidity: '1',
      senderAddress: message.senderAddress, senderName: message.senderName, subject: message.subject, body: message.body,
      sentAtMs: clock.parse(message.sentAtIso), receivedAtMs: clock.parse(message.sentAtIso) + 1000,
      ...(message.uid === 1 ? { attachments: [{ partId: '2', format: 'pdf' as const, byteLength: syntheticPdf().length }] } : {}) }))
    return { unseenCount: messages.length, messages }
  }, readAttachment: async (mail, signal) => {
    signal.throwIfAborted()
    if (mail.uidValidity !== '1' || mail.uid !== 1 || mail.partId !== '2') throw new Error('SYNTHETIC_ATTACHMENT_UNKNOWN')
    return syntheticPdf()
  } }
  const privacy: EmailPrivacyModel = { source: 'fake', extract: async (input, signal) => {
    signal.throwIfAborted()
    if (scenario === 'privacy-failure') throw new Error('SYNTHETIC_PRIVACY_UNAVAILABLE')
    const message = fixture.messages.find((item) => input.sourceId === `1:${item.uid}`)
    if (!message) throw new Error('SYNTHETIC_MESSAGE_UNKNOWN')
    return structuredClone(message.extraction)
  } }
  return { source, privacy, scenario: () => scenario, select: (value: MailScenarioId) => { scenario = value } }
}
/** Deliberately does no network/config access while the real transport remains blocked. */
export function createBlockedImapSource(): MailSource {
  return { source: 'real', blocked: true, readUnseen: async () => { throw new Error('IMAP_RECORDED_BLOCKED') } }
}

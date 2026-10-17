import { describe, expect, it } from 'vitest'
import { mailContentHash, mailContentHashWithIdentity } from '../../src/main/mail/evidence-vault'
import type { SourceMail } from '../../src/main/mail/types'

const base: SourceMail = { uidValidity: '7', uid: 3, senderAddress: 'ta@example.test', senderName: 'TA', subject: '作业', body: '正文', sentAtMs: 1_000, receivedAtMs: 1_001 }
const withMailbox: SourceMail = { ...base, mailboxId: 'a'.repeat(64) }

describe('mail content hash compatibility', () => {
  it('does not treat transport-only mailbox identity or attachment metadata as content changes', () => {
    expect(mailContentHash(withMailbox)).toBe(mailContentHash(base))
    expect(mailContentHashWithIdentity(withMailbox)).not.toBe(mailContentHash(base))
    expect(mailContentHash({ ...base, attachments: [{ partId: '1', format: 'pdf', byteLength: 8 }] })).toBe(mailContentHash(base))
  })

  it('still detects actual body changes', () => {
    expect(mailContentHash({ ...base, body: '正文改了' })).not.toBe(mailContentHash(base))
  })
})

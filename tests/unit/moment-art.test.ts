import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import book from '../../src/renderer/src/voice/book.zh.json'
import { SCENARIOS } from '../../src/renderer/src/dev/scenarios'

const moments = resolve('src/renderer/src/assets/character/taozi/moments')
const ui = resolve('src/renderer/src/assets/ui')
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('life moments (新邮件快照与递笔插图)', () => {
  it('ships the two moment images and the mail icon with matching manifest hashes', () => {
    const manifest = JSON.parse(readFileSync(resolve(moments, 'manifest.json'), 'utf8')) as {
      assets: { runtime: string; sha256: string }[]
    }
    for (const [runtime, path] of [
      ['../moments/first-notice.png', resolve(moments, 'first-notice.png')],
      ['../moments/quill-offer.png', resolve(moments, 'quill-offer.png')],
      ['../../ui/mail.png', resolve(ui, 'mail.png')],
    ] as const) {
      expect(existsSync(path), runtime).toBe(true)
      const entry = manifest.assets.find((asset) => asset.runtime === runtime)
      expect(entry, runtime).toBeTruthy()
      expect(hash(path), runtime).toBe(entry!.sha256)
    }
  })

  it('has copy for the new-mail polaroid and a demo scene that shows it', () => {
    expect(book.mailMoment.title).toBeTruthy()
    expect(book.mailMoment.count).toContain('{count}')
    const scene = SCENARIOS['mail-new']
    expect(scene.companion.mailboxUnseen).toBeGreaterThan(0)
    expect(scene.capabilities.find((item) => item.id === 'mail')?.status).toBe('ready')
  })

  it('never renders the moment when the mailbox is not connected (failure is not zero mail)', () => {
    const failed = SCENARIOS['mail-failed']
    expect(failed.capabilities.find((item) => item.id === 'mail')?.status).not.toBe('ready')
    expect(failed.companion.mailboxUnseen).toBe(0)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createManualClock } from '../../src/main/clock'
import { createAppController } from '../../src/main/bridge/controller'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { carryPreviousState } from '../../src/main/store/carry'
import type { SessionStore } from '../../src/main/store/session'
import { initialOnboarding, onboardingProfileInput } from '../../src/main/onboarding/schema'
import { profileContext } from '../../src/main/onboarding/context'
import { seenFragments } from '../../src/main/memory/seen'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-onboarding-')); const clock = createManualClock(1000)
  cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-onboarding-'))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) })
  const open = (userId = 'u', characterId = 'c') => {
    const journal = openJournal(root, { userId, characterId }, clock); carryPreviousState(journal, root, { userId, characterId }, clock)
    const store: SessionStore = { scope: journal.scope, projection: () => projectJournal(journal.records()), records: journal.records, append: journal.append, close: journal.close }
    const controller = createAppController(clock, undefined, store); let closed = false
    const close = () => { if (!closed) { closed = true; journal.close() } }; cleanups.push(close)
    const send = (body: Record<string, unknown>, surface: 'book' | 'mini' | 'diagnostics' = 'book', requestId = randomUUID()) => controller.dispatch({ protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId, ...body }, surface)
    return { store, controller, send, close }
  }
  return { root, clock, open }
}

describe('main-owned onboarding profile and experience boundary', () => {
  it('starts needed; booth always completes and refuses reset, including before replay', () => {
    const clock = createManualClock(); const controller = createAppController(clock, undefined, undefined, { booth: true })
    expect(controller.getSnapshot().onboarding).toEqual({ ...initialOnboarding(), status: 'completed' })
    const base = { protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: 'reset' }
    expect(controller.dispatch({ ...base, type: 'onboarding.reset' })).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } })
    expect(fixture().open().controller.getSnapshot().onboarding).toEqual(initialOnboarding())
  })
  it('validates Unicode length, single-line input and atomic partial updates in main', () => {
    const { open } = fixture(); const f = open(); const count = () => f.store.records().length
    expect(onboardingProfileInput.parse({ userName: '  小林  ' })).toEqual({ userName: '小林' })
    expect(f.send({ type: 'onboarding.profile', userName: '🙂'.repeat(20), characterName: '桃'.repeat(12) }).status).toBe('accepted')
    for (const body of [{}, { userName: '字'.repeat(21) }, { characterName: '桃'.repeat(13) }, { userName: ' a\nb ' }, { characterName: '\t桃子' }, { userName: '甲\u2028乙' }, { userName: '甲\u202e乙' }]) {
      const before = count(); expect(f.send({ type: 'onboarding.profile', ...body }).status).toBe('rejected'); expect(count()).toBe(before)
    }
    expect(f.send({ type: 'onboarding.profile', userName: '  小林  ' }).status).toBe('accepted')
    expect(f.controller.getSnapshot().onboarding).toMatchObject({ userName: '小林', characterName: '桃'.repeat(12), status: 'needed' })
    f.send({ type: 'onboarding.profile', userName: ' ', characterName: '' }); expect(f.controller.getSnapshot().onboarding).toEqual(initialOnboarding())
  })
  it('persists incomplete names and completion time through restart and a daily carry without leaking scope', () => {
    const { open, clock } = fixture(); const f = open(); f.send({ type: 'onboarding.profile', userName: '小林', characterName: '小桃' }); f.close()
    const again = open(); expect(again.controller.getSnapshot().onboarding).toMatchObject({ status: 'needed', userName: '小林', characterName: '小桃' })
    again.send({ type: 'onboarding.complete' }); const completed = again.controller.getSnapshot().onboarding
    expect(completed?.completedAtMs).toBe(1000); clock.advanceBy(1000); again.send({ type: 'onboarding.complete' }); expect(again.controller.getSnapshot().onboarding).toEqual(completed)
    again.close(); clock.advanceBy(24 * 60 * 60_000); const nextDay = open(); expect(nextDay.controller.getSnapshot().onboarding).toEqual(completed)
    expect(open('other-user').controller.getSnapshot().onboarding).toEqual(initialOnboarding()); expect(open('u', 'other-character').controller.getSnapshot().onboarding).toEqual(initialOnboarding())
  })
  it('reopens initialization without deleting names or chat and denies forged non-book commands', () => {
    const f = fixture().open(); f.send({ type: 'onboarding.profile', userName: '小林' }); f.send({ type: 'onboarding.complete' })
    f.store.append({ type: 'user/message', text: '保留这段聊天', id: 'message', requestId: 'm', commandHash: 'm' })
    f.send({ type: 'onboarding.reset' }); expect(f.controller.getSnapshot().onboarding).toMatchObject({ status: 'needed', completedAtMs: null, userName: '小林' })
    expect(f.store.projection().messages[0].text).toBe('保留这段聊天')
    const body = { type: 'onboarding.profile', characterName: '小桃' }; const id = randomUUID(); f.send(body, 'book', id)
    for (const surface of ['mini', 'diagnostics'] as const) expect(f.send(body, surface, id)).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } })
  })
  it('gives the character and about-you layers to her persona separately, never as conversation or eligible experience', async () => {
    const f = fixture().open(); f.send({ type: 'onboarding.profile', userName: 'PROFILE_USER_ONLY', characterName: 'PROFILE_CHAR' })
    expect(f.store.projection().context).toEqual([]); expect(seenFragments(f.store.records())).toEqual([])
    // Her DSH persona is the policy, these two layers and the character card (index.ts persona).
    const layers = profileContext(f.store.projection().onboarding)
    expect(layers).toHaveLength(2); expect(layers.every((layer) => layer.role === 'system')).toBe(true)
    expect(layers[0].content).not.toContain('PROFILE_USER_ONLY'); expect(layers[1]).toMatchObject({ content: expect.stringContaining('关于对方') })
    expect(seenFragments(f.store.records())).toEqual([])
    f.send({ type: 'onboarding.profile', characterName: '新称呼' }); expect(profileContext(f.store.projection().onboarding)[0].content).toContain('新称呼')
  })
  it('keeps the optional about-you text: multi-line, bounded, tidied, kept as typed, removable, only in the about-you layer', () => {
    const { open } = fixture(); const f = open(); const count = () => f.store.records().length
    expect(onboardingProfileInput.parse({ aboutUser: '  第一行 \r\n\r\n\r\n\r\n\t第二行\t\n  ' })).toEqual({ aboutUser: '第一行\n\n\t第二行' })
    for (const aboutUser of ['字'.repeat(501), '甲\u0007乙', '甲\u202e乙', '甲\u2028乙', '甲\u200b乙']) {
      const before = count(); expect(f.send({ type: 'onboarding.profile', aboutUser }).status).toBe('rejected'); expect(count()).toBe(before)
    }
    expect(f.send({ type: 'onboarding.profile', userName: '小林', aboutUser: '🙂'.repeat(500) }).status).toBe('accepted')
    // `$&` and `$$` would be replacement patterns in String.replace; the user's words must reach her unchanged.
    const about = '最近在赶毕业设计。\n提到我时用“她”。价格写作 $& 和 $$，原样保留。'
    expect(f.send({ type: 'onboarding.profile', aboutUser: about }).status).toBe('accepted'); f.close()
    const again = open(); expect(again.controller.getSnapshot().onboarding).toMatchObject({ userName: '小林', aboutUser: about })
    const layers = profileContext(again.store.projection().onboarding)
    expect(layers[0].content).not.toContain('毕业设计'); expect(layers[1].content).toContain(JSON.stringify({ userName: '小林', aboutUser: about }))
    expect(again.store.projection().context).toEqual([]); expect(seenFragments(again.store.records())).toEqual([])
    // A name edit leaves it alone; an empty text removes it and the stored profile returns to its old shape.
    again.send({ type: 'onboarding.profile', userName: '林' }); expect(again.controller.getSnapshot().onboarding?.aboutUser).toBe(about)
    expect(again.send({ type: 'onboarding.profile', aboutUser: '  \n ' }).status).toBe('accepted')
    expect(again.controller.getSnapshot().onboarding).not.toHaveProperty('aboutUser')
    expect(profileContext(again.store.projection().onboarding)[1].content).toContain(JSON.stringify({ userName: '林' }))
    // Only the text, without a name, still reaches her as the about-you layer.
    again.send({ type: 'onboarding.profile', userName: '', aboutUser: '只写了介绍' })
    expect(profileContext(again.store.projection().onboarding)).toHaveLength(2)
  })
})

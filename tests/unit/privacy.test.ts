import { describe, expect, it } from 'vitest'
import { createFakePrivacyModel, createPrivacyFilter } from '../../src/main/privacy/filter'

describe('privacy narrow boundary', () => {
  it('requires an explicit model, labels fake output, and fails closed', async () => {
    expect(await createPrivacyFilter(null)('synthetic input')).toEqual({ ok: false, error: 'privacy-unavailable' })
    expect(await createPrivacyFilter(createFakePrivacyModel())('synthetic input')).toMatchObject({ ok: true, source: 'fake', trust: 'untrusted' })
    expect(await createPrivacyFilter({ source: 'real', extract: async () => { throw new Error('private upstream error') } })('synthetic input')).toEqual({ ok: false, error: 'privacy-unavailable' })
  })
  it('rejects arbitrary text, extra keys and malformed dates', async () => {
    for (const output of [
      { kind: 'notice', deadlineIso: null, task: 'x'.repeat(21) },
      { kind: 'notice', deadlineIso: null, task: 'test', raw: 'must not escape' },
      { kind: 'notice', deadlineIso: '2026-02-31T01:00:00Z', task: 'test' },
    ]) expect(await createPrivacyFilter(createFakePrivacyModel(output))('synthetic')).toEqual({ ok: false, error: 'privacy-invalid-output' })
  })
})

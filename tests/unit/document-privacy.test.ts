import { describe, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createFakeDocumentModel, organizeDocument, type DocumentPrivacyModel } from '../../src/main/documents/privacy'
import { extractDocument } from '../../src/main/documents/reader'

const clock = createManualClock(0)
const input = { text: 'PRIVATE_DOCUMENT_SOURCE\n截止：2026 年 10 月 24 日 23:59\nEmail: fixture@example.invalid\nAPI key: sk-syntheticdocumentkey1234567890', pageCount: 1, format: 'pdf' as const }
const signal = () => new AbortController().signal
describe('isolated document processing', () => {
  it('uses a separate no-tools dependency, redacts credentials, and validates dates against private source', async () => {
    const fake = createFakeDocumentModel(clock)
    const model: DocumentPrivacyModel = { source: 'fake', ready: true, organize: vi.fn(async (data, abort) => {
      expect(JSON.stringify(data)).not.toContain('sk-synthetic'); expect(data.text).not.toContain('fixture@example.invalid'); expect(data).not.toHaveProperty('tools')
      return fake.model.organize(data, abort)
    }) }
    const result = await organizeDocument(input, model, clock, signal())
    expect(result.deadlineIso).toBe('2026-10-24T23:59:00+08:00'); expect(result.markdown).toContain('PRIVATE_DOCUMENT_SOURCE'); expect(result.markdown).not.toContain('sk-synthetic')
    expect(model.organize).toHaveBeenCalledTimes(1)
  })
  it('rejects missing dependencies, fault output, invented dates, and extra instructions without a main fallback', async () => {
    await expect(organizeDocument(input, null, clock, signal())).rejects.toMatchObject({ code: 'privacy-unavailable' })
    const fake = createFakeDocumentModel(clock)
    for (const scenario of ['privacy-failure', 'malicious'] as const) {
      fake.select(scenario); await expect(organizeDocument(input, fake.model, clock, signal())).rejects.toMatchObject({ code: scenario === 'malicious' ? 'privacy-invalid-output' : 'privacy-unavailable' })
    }
    await expect(organizeDocument(input, { ready: true, source: 'fake', organize: async () => ({ markdown: 'PRIVATE', deadline: { iso: '2026-10-26T23:59:00+08:00', quote: '2026 年 10 月 24 日 23:59' } }) }, clock, signal())).rejects.toMatchObject({ code: 'privacy-invalid-output' })
  })
  it('stops a hanging dependency through the unified clock and abort signal', async () => {
    const model: DocumentPrivacyModel = { source: 'fake', ready: true, organize: vi.fn(() => new Promise(() => {})) }
    const pending = organizeDocument(input, model, clock, signal()); clock.advanceBy(30_000)
    await expect(pending).rejects.toMatchObject({ code: 'privacy-unavailable' })
    const abort = new AbortController(); const cancelled = organizeDocument(input, model, clock, abort.signal); abort.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'privacy-unavailable' }); expect(model.organize).toHaveBeenCalledTimes(2)
  })
  it('decodes UTF-8 text strictly and rejects binaries, empty files and bounds violations', async () => {
    expect(await extractDocument(Buffer.from('合成资料\nMarkdown text'), 'text', clock, signal())).toEqual({ text: '合成资料\nMarkdown text', pageCount: null })
    for (const bytes of [Buffer.from([0xff, 0xfe, 0]), Buffer.from('a\0b'), Buffer.from(' '), Buffer.from('a'.repeat(120_001))]) await expect(extractDocument(bytes, 'text', clock, signal())).rejects.toMatchObject({ code: 'document-parse-failed' })
    await expect(extractDocument(new Uint8Array(10 * 1024 * 1024 + 1), 'pdf', clock, signal())).rejects.toMatchObject({ code: 'file-too-large' })
    await expect(extractDocument(Buffer.from('not a PDF'), 'pdf', clock, signal())).rejects.toMatchObject({ code: 'document-parse-failed' })
  })
})

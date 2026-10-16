import { PDFParse } from 'pdf-parse'

process.once('message', async (bytes: Uint8Array) => {
  const parser = new PDFParse({ data: bytes, verbosity: 0, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, stopAtErrors: true })
  try {
    const result = await parser.getText({ first: 1, last: 60 })
    if (result.total < 1 || result.total > 60 || result.text.length > 120_000 || !result.pages.some((page) => page.text.trim())) throw new Error('PARSE_INVALID')
    process.send!({ ok: true, text: result.pages.map((page) => page.text).join('\n\n'), pageCount: result.total })
  } catch { process.send!({ ok: false }) }
  finally { await parser.destroy().catch(() => {}); process.disconnect() }
})

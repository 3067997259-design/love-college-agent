import { createHash } from 'node:crypto'
import type { SessionStore } from '../store/session'
import { witnessedPage } from '../history/seen'
import { groundingVerdict } from '../memory/grounding'
import type { OpticalFrame, OpticalImpression } from './schema'
export const opticalHash = (value: string) => createHash('sha256').update(value).digest('hex')
export const opticalFrameId = (owner: { userId: string; characterId: string }, frame: Pick<OpticalFrame, 'sessionId' | 'pageIndex' | 'pageCount' | 'sources'>) => opticalHash(JSON.stringify([owner.userId, owner.characterId, frame.sessionId, frame.pageIndex, frame.pageCount, frame.sources]))
export function opticalPages(store: SessionStore, sessionId: string) {
  if (sessionId === store.scope.sessionId) throw new Error('OPTICAL_OPEN_PAGE')
  const page = store.pages?.().find((page) => page.sessionId === sessionId)
  if (!page) throw new Error('OPTICAL_PAGE_UNAVAILABLE')
  const messages = witnessedPage(store, sessionId)
  const lines: { role: 'user' | 'assistant'; text: string; source: OpticalFrame['sources'][number] }[] = []
  for (const message of messages) {
    let start = 0; let end = 0; let part = ''; let width = 0
    const flush = () => { if (part.trim()) lines.push({ role: message.role, text: part, source: { messageId: message.messageId, frameSeq: message.frameSeq, index: message.index, start, end, sha256: opticalHash(part) } }); part = ''; start = end; width = 0 }
    for (const char of message.text) {
      if (char === '\r' || char === '\n') { flush(); end += char.length; start = end; continue }
      const units = char.codePointAt(0)! >= 0x1f000 ? 4 : char.codePointAt(0)! < 256 ? 1 : 2
      if (width + units > 70) flush()
      part += char; end += char.length; width += units
      if (width >= 70) flush()
    }
    flush()
  }
  if (!lines.length || lines.length > 24 * 64) throw new Error('OPTICAL_PAGE_LIMIT')
  const pageCount = Math.ceil(lines.length / 24)
  return Array.from({ length: pageCount }, (_, pageIndex) => {
    const selected = lines.slice(pageIndex * 24, (pageIndex + 1) * 24)
    const base = { sessionId, pageIndex, pageCount, sources: selected.map((line) => line.source) }
    return { ...base, id: opticalFrameId(store.scope, base), text: selected.map((line) => (line.role === 'user' ? 'U: ' : 'A: ') + line.text).join('\n') }
  })
}
export function opticalProof(store: SessionStore, frame: OpticalFrame) {
  if (frame.id !== opticalFrameId(store.scope, frame)) throw new Error('OPTICAL_FRAME_INVALID')
  const messages = witnessedPage(store, frame.sessionId)
  return frame.sources.map((source) => {
    const message = messages.find((message) => message.messageId === source.messageId && message.frameSeq === source.frameSeq && message.index === source.index)
    if (!message || source.end > message.text.length || opticalHash(message.text.slice(source.start, source.end)) !== source.sha256) throw new Error('OPTICAL_SOURCE_CHANGED')
    return { source, message }
  })
}
/** Never fuzzy-match an OCR replacement into a fact. Only retain witnessed exact spans with intact scope. */
export function guardOptical(store: SessionStore, frame: OpticalFrame, decoded: string) {
  const proof = opticalProof(store, frame); const fragments: OpticalImpression['fragments'] = []; let rejectedLineCount = 0
  const candidates = decoded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const raw of candidates) {
    const text = raw.replace(/^(?:U|A):\s*/, '')
    if (text.length < 4 || text.length > 2000 || fragments.length >= 24 || fragments.some((fragment) => fragment.text === text)) { rejectedLineCount++; continue }
    let found: OpticalImpression['fragments'][number] | undefined
    for (const { source, message } of proof) {
      let start = message.text.indexOf(text, source.start)
      while (start >= 0 && start < source.end) {
        const end = start + text.length
        // Every character must be on this frame; adjacent printed spans of the same message may join.
        const coverage = proof.filter((entry) => entry.message.messageId === message.messageId).map((entry) => entry.source).sort((a, b) => a.start - b.start)
        let covered = start
        for (const span of coverage) if (span.start <= covered && span.end > covered) covered = span.end
        if (covered >= end && groundingVerdict(message.text, text, start, end).entailed) { found = { text, messageId: message.messageId, start, end }; break }
        start = message.text.indexOf(text, start + 1)
      }
      if (found) break
    }
    if (found) fragments.push(found); else rejectedLineCount++
  }
  return { fragments, rejectedLineCount }
}
export function validateOpticalImpression(store: SessionStore, frame: OpticalFrame, impression: OpticalImpression) {
  if (impression.frameId !== frame.id || impression.fragments.some((fragment) => {
    const guarded = guardOptical(store, frame, fragment.text)
    return !guarded.fragments.some((match) => match.messageId === fragment.messageId && match.start === fragment.start && match.end === fragment.end)
  })) throw new Error('OPTICAL_IMPRESSION_INVALID')
}

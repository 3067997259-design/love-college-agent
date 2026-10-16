/**
 * Grounding check: may the extracted quote be read as a claim of the source sentence?
 *
 * `source.includes(quote)` is not entailment. It accepts a quote whose negation was left outside the
 * span, whose operator scope was cut open, or that was sliced out of a numeral. This module answers the
 * narrower question the pipeline actually needs:
 *
 *   Does S entail the assertion made by the exact span S[i..j]?
 *
 * The check is deterministic and model-free. It is a shallow scope analysis, not a parser and not a
 * full Natural Logic calculus: it labels a small closed set of Chinese polarity operators, decides which
 * of them dominate the span, and refuses spans that cut through protected tokens. Every rejection names
 * the rule that fired so a reviewer can disagree with a specific rule instead of a score.
 */
export type GroundingReason = 'included' | 'not-a-substring' | 'factored' | 'span-split' | 'scope-operator' | 'polarity-odd'
export interface GroundingVerdict { entailed: boolean; reason: GroundingReason; detail?: string }

/** Clausal negators: they flip the polarity of the predicate, so an odd count inside the span cancels it. */
const CLAUSAL_NEGATORS = ['不再', '不用', '不需', '不必', '不会', '不能', '不得', '不应', '没有', '并非', '未', '没', '不', '别', '勿', '无']
/** Non-factive or hypothetical operators: material under them is not asserted as a current fact. */
const NON_FACTIVE = ['如果', '假如', '若', '除非', '万一', '要是', '是否', '是不是', '有没有', '能否', '是不是', '才', '有同学问', '听说', '据说']
/** A span that begins at one of these cut a negator off its verb. */
const HAN = /[\u3400-\u9fff]/
/** Characters that head a verb phrase, so an operator ending right before them is that phrase's operator. */
const VERB_PHRASE = /[喝吃用看写交做去来买学发提参领填说读听想在给带]/
/** A tail clause that carries a predicate; used to refuse spans that stop on a bare noun phrase. */
const VERBISH = /[是在有改交提发参领填说读听想做去来给带用下上开关注记写看吃喝买学进出完成需可以必须]/
const PUNCTUATION = /[。！？；，、：\n（）()【】《》“”]/

/** Cut a sentence into clauses so an operator in one clause cannot reach into another. */
function clauseBoundaries(text: string): number[] {
  const bounds = [0]
  for (let index = 0; index < text.length; index++) if (PUNCTUATION.test(text[index])) bounds.push(index + 1)
  bounds.push(text.length)
  return [...new Set(bounds)].sort((a, b) => a - b)
}
const clauseOf = (bounds: readonly number[], start: number) => {
  let begin = 0; let end = bounds[bounds.length - 1]
  for (const bound of bounds) { if (bound <= start) begin = bound; else { end = bound; break } }
  return { begin, end }
}

/** Largest numeral or quantifier token containing `index`, or undefined when the character is not part of one. */
function numeralRun(text: string, index: number): { start: number; end: number } | undefined {
  if (index < 0 || index >= text.length) return undefined
  const numeral = /[0-9０-９]/
  if (!numeral.test(text[index])) return undefined
  let start = index; let end = index + 1
  while (start > 0 && numeral.test(text[start - 1])) start--
  while (end < text.length && numeral.test(text[end])) end++
  return { start, end }
}

/**
 * Decide whether `source` entails the assertion carried by the exact occurrence `[start, end)`.
 * The caller supplies the span because it owns the redaction mapping; `quote` must equal that span.
 */
export function groundingVerdict(source: string, quote: string, start: number, end: number): GroundingVerdict {
  if (start < 0 || end > source.length || end <= start || source.slice(start, end) !== quote) return { entailed: false, reason: 'not-a-substring' }
  const bounds = clauseBoundaries(source)
  const clause = clauseOf(bounds, start)

  // (1) Factoring: a single-token span, a span cut out of a numeral, or a span that begins on a bare
  // operator, asserts something the source never asserted.
  if (end - start === 1 && HAN.test(source[start])) return { entailed: false, reason: 'factored', detail: 'single-character span' }
  const leftRun = numeralRun(source, start - 1)
  if (leftRun && leftRun.end > start) return { entailed: false, reason: 'factored', detail: 'splits a numeral' }

  // (2) Span integrity. A span may cover several clauses, but every clause boundary it reaches must be
  // quoted with it: cutting a span so that it stops right before the boundary drops the predicate
  // ("下周交，地点" out of "报告下周交，地点改到三楼"), and a boundary inside the span that the span
  // does not itself contain means the span skips over clause material.
  const interior = bounds.filter((bound) => bound > start && bound <= end && bound < source.length)
  // Every boundary the span reaches must carry its punctuation inside the span, otherwise the span stops
  // just before it and leaves the predicate behind ("下周交，地点" out of "报告下周交，地点改到三楼").
  if (interior.some((bound) => source[bound - 1] !== quote[bound - 1 - start])) return { entailed: false, reason: 'span-split', detail: 'cuts a clause boundary' }
  if (interior.length === 0 && clause.end < end) return { entailed: false, reason: 'span-split', detail: 'crosses a clause boundary' }

  // (3) Polarity parity. A clausal negator belongs to its head token: the character right after it.
  // Every negator whose head reaches into the span flips the span's truth, whether it sits inside the
  // span (double negation stays affirmative) or immediately before it ("今天不用交作业" quoted as
  // "交作业" asserts the opposite of the sentence). A negator whose head stops before the span governs
  // the predicate from outside. A negator whose head lands exactly on the span start is treated as
  // internal only when it chains with the span's own first negator ("并非不" + "需要…"): otherwise it is
  // that word's own operator, with the object quoted out from under it ("不" + "交作业").
  const negatorAtStart = CLAUSAL_NEGATORS.some((token) => quote.startsWith(token))
  const previousNegator = (from: number, to: number) => {
    const begin = Math.max(clause.begin, from - 6)
    if (begin >= to) return false
    const window = source.slice(begin, to)
    return CLAUSAL_NEGATORS.some((token) => window.includes(token))
  }
  for (let index = start - 1; index >= Math.max(clause.begin, start - 4); index--) {
    const window = source.slice(Math.max(clause.begin, index - 3), index + 1)
    const hypothetical = NON_FACTIVE.find((token) => window.endsWith(token))
    if (hypothetical) return { entailed: false, reason: 'scope-operator', detail: 'hypothetical or non-factive: ' + hypothetical }
    const negator = [...CLAUSAL_NEGATORS].sort((a, b) => b.length - a.length).find((token) => window.endsWith(token))
    if (!negator) continue
    const head = index + 1
    const operatorStart = head - negator.length
    const chains = negatorAtStart || previousNegator(operatorStart, operatorStart)
    const internal = head > start || (head === start && chains)
    if (!internal) return { entailed: false, reason: 'scope-operator', detail: 'dominating negator outside the span: ' + negator }
    break
  }

  // (4) Stripped predicate operator. "不再喝咖啡" quoted as "喝咖啡" leaves the negator one character
  // outside the span, where the backward scan cannot see it as a whole token. Only fire when the
  // character right before the span completes an operator; "并非不" + "需要…" chains two negators and
  // is handled by the parity of case (3) instead.
  const clip = source.slice(Math.max(clause.begin, start - 2), start)
  const negatorBefore = /^(?:不|没|未|别|勿|无)(?:再|用|需|必|会|能|得|应)?$/.test(clip)
  const chained = /(?:并非|不是|没有|不|没|未)$/.test(source.slice(Math.max(clause.begin, start - clip.length - 2), start - clip.length))
  if (negatorBefore && !chained && VERB_PHRASE.test(quote[0] ?? '')) return { entailed: false, reason: 'factored', detail: 'strips a predicate operator: ' + clip }

  // (5) Truncated tail clause. A span that reaches a clause boundary and then stops on a bare phrase
  // keeps the front of the sentence but drops the predicate that followed the boundary.
  const tailAt = Math.max(...bounds.filter((bound) => bound > start && bound <= end), start)
  const tail = quote.slice(tailAt - start)
  if (tailAt > start && tail.length > 0 && !VERBISH.test(tail)) return { entailed: false, reason: 'span-split', detail: 'ends on a bare phrase: ' + tail }
  return { entailed: true, reason: 'included' }
}

/** Convenience wrapper for the common "does this text contain the quote, and does it entail it" case. */
export function groundedIn(source: string, quote: string): GroundingVerdict {
  const at = source.indexOf(quote)
  if (at < 0) return { entailed: false, reason: 'not-a-substring' }
  return groundingVerdict(source, quote, at, at + quote.length)
}

import type { MemoryExtraction } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric))
    return fallback
  return Math.min(max, Math.max(min, numeric))
}

/**
 * Normalizes one model-authored chat-turn extraction payload into fact extractions.
 *
 * The prompt demands a JSON array, but the payload is still model output, so
 * every entry must pass structural checks before it can be persisted. An entry
 * mislabeled as `muscle` is corrected to `short_term`
 * (MEMORY-SEMANTICS-CORRECTION §3.3): the content stays available through the
 * ordinary fact review gate instead of becoming a zero-token reflex. Entries
 * without a usable fact shape are dropped.
 *
 * @example
 * parseMemoryTurnExtractions(
 *   [{ content: 'The user prefers tests before edits', category: 'chat', memoryType: 'muscle' }],
 *   { sessionId: 's1' },
 * )
 * // => [{ content: 'The user prefers tests before edits', category: 'chat', memoryType: 'short_term', importance: 5, valence: 0, arousal: 0, tags: [], sessionId: 's1' }]
 */
export function parseMemoryTurnExtractions(value: unknown, input: { sessionId: string }): MemoryExtraction[] {
  if (!Array.isArray(value))
    return []

  return value.flatMap((item) => {
    if (!isRecord(item)
      || typeof item.content !== 'string'
      || !item.content.trim()
      || typeof item.category !== 'string'
      || (item.memoryType !== 'short_term' && item.memoryType !== 'muscle')) {
      return []
    }

    const episodic = isRecord(item.episodic)
      && typeof item.episodic.eventType === 'string'
      && item.episodic.eventType.trim().length > 0
      && Array.isArray(item.episodic.participants)
      ? {
          eventType: item.episodic.eventType.trim(),
          participants: item.episodic.participants.filter((participant): participant is string => typeof participant === 'string' && participant.trim().length > 0).map(participant => participant.trim()),
          ...(typeof item.episodic.location === 'string' && item.episodic.location.trim().length > 0 ? { location: item.episodic.location.trim() } : {}),
        }
      : undefined

    return [{
      content: item.content.trim(),
      category: item.category,
      memoryType: 'short_term',
      importance: clampNumber(item.importance, 1, 10, 5),
      valence: clampNumber(item.valence, -1, 1, 0),
      arousal: clampNumber(item.arousal, 0, 1, 0),
      tags: Array.isArray(item.tags)
        ? item.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      sessionId: input.sessionId,
      ...(episodic ? { episodic } : {}),
    }]
  })
}

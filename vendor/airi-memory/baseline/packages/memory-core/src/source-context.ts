import type { MemorySourceContext } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const MAX_SOURCE_NEIGHBORS = 4
const MAX_SOURCE_NEIGHBOR_LENGTH = 600

/**
 * Reads the world-scoped game binding from persisted source context (mc-1b).
 *
 * The whole object is written on insert, but reads reconstruct known fields;
 * without this parser a stored `gameWorld` would be dropped and every game
 * fact would read as world-less.
 */
function parseGameWorld(value: unknown): MemorySourceContext['gameWorld'] | undefined {
  if (!isRecord(value) || typeof value.worldId !== 'string' || value.worldId.length === 0)
    return undefined
  if (typeof value.connectionGeneration !== 'number' || !Number.isFinite(value.connectionGeneration))
    return undefined
  if (typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt))
    return undefined
  return {
    worldId: value.worldId,
    connectionGeneration: value.connectionGeneration,
    ...(typeof value.connectionId === 'string' && value.connectionId.length > 0 ? { connectionId: value.connectionId } : {}),
    dimension: typeof value.dimension === 'string' ? value.dimension : '',
    observedAt: value.observedAt,
  }
}

/**
 * Reads persisted source context from a JSON value.
 *
 * @example
 * parseMemorySourceContext({ sessionId: 'session-1', neighbors: ['User: hello'] })
 * // => { sessionId: 'session-1', neighbors: ['User: hello'] }
 */
export function parseMemorySourceContext(value: unknown): MemorySourceContext | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !Array.isArray(value.neighbors))
    return undefined

  const neighbors = value.neighbors
    .filter((neighbor): neighbor is string => typeof neighbor === 'string' && neighbor.trim().length > 0)
    .map(neighbor => neighbor.slice(0, MAX_SOURCE_NEIGHBOR_LENGTH))
    .slice(0, MAX_SOURCE_NEIGHBORS)
  const messageId = typeof value.messageId === 'string' && value.messageId.length > 0
    ? value.messageId
    : undefined
  const sourceEventId = typeof value.sourceEventId === 'string' && value.sourceEventId.length > 0
    ? value.sourceEventId
    : undefined
  const sourceType = typeof value.sourceType === 'string' && value.sourceType.length > 0
    ? value.sourceType
    : undefined
  const gameWorld = parseGameWorld(value.gameWorld)

  return {
    sessionId: value.sessionId,
    ...(messageId ? { messageId } : {}),
    ...(sourceEventId ? { sourceEventId } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(gameWorld ? { gameWorld } : {}),
    neighbors,
  }
}

// Adapted from AIRI (MIT). Pinned source and modifications: vendor/airi-memory/README.md
// Upstream: packages/stage-ui/src/services/memory/interaction-repository.ts
import type { MemoryEmbeddingMetadata, MemoryFragment, MemoryOperation, MemoryRepository, MemoryScope, MemorySourceContext } from '../core/index'

import { parseMemorySourceContext, validateMemoryProposal } from '../core/index'

import * as v from 'valibot'

const identifier = v.pipe(v.string(), v.minLength(1))
const revision = v.pipe(v.number(), v.integer(), v.minValue(1))
const operationSchema = v.strictObject({
  operationId: identifier,
  sessionId: identifier,
  turnId: identifier,
  scope: v.strictObject({ userId: identifier, characterId: identifier }),
  proposal: v.strictObject({
    kind: v.picklist(['remember', 'correct', 'forget']),
    targetId: v.optional(identifier),
    expectedRevision: v.optional(revision),
    content: v.optional(v.pipe(v.string(), v.maxLength(2000))),
    title: v.optional(v.pipe(v.string(), v.maxLength(64))),
    summary: v.optional(v.pipe(v.string(), v.maxLength(150))),
  }),
  sourceContext: v.custom<MemorySourceContext>(value => parseMemorySourceContext(value) !== undefined),
  status: v.picklist(['pending_review', 'applied', 'rejected', 'conflict']),
  fragmentId: v.optional(identifier),
  previousContent: v.optional(v.string()),
  previousSourceContext: v.optional(v.custom<MemorySourceContext>(value => parseMemorySourceContext(value) !== undefined)),
  mirrorPending: v.optional(v.boolean()),
  createdAt: v.pipe(v.number(), v.finite()),
  updatedAt: v.pipe(v.number(), v.finite()),
})

/** Rejects malformed receipts from storage or backup before they become user confirmation targets. */
export function parseMemoryOperation(value: unknown): MemoryOperation {
  const operation = v.parse(operationSchema, value)
  validateMemoryProposal(operation.proposal)
  if (operation.sourceContext.sessionId !== operation.sessionId || !operation.sourceContext.messageId)
    throw new Error('Memory operation source does not match its session')
  return operation
}

/** Local fact operations use one transaction and share the existing DuckDB snapshot owner. */
export interface MemoryInteractionRepository extends MemoryRepository {
  get: (id: string) => Promise<MemoryFragment | undefined>
  directory: (scope: MemoryScope, linkedUserIds?: readonly string[]) => Promise<MemoryFragment[]>
  operation: (operationId: string) => Promise<MemoryOperation | undefined>
  operationForFragment: (fragmentId: string) => Promise<MemoryOperation | undefined>
  operations: (scope: MemoryScope, sessionId?: string) => Promise<MemoryOperation[]>
  sourceOperations: (scope: MemoryScope, sessionId: string, messageId: string) => Promise<MemoryOperation[]>
  /** Native reviewed, revised or deleted source facts; suppression evidence, never recall results. */
  sourceFacts: (scope: MemoryScope, sessionId: string, messageId: string) => Promise<MemoryFragment[]>
  pendingMirrorOperations: () => Promise<MemoryOperation[]>
  saveOperation: (operation: MemoryOperation) => Promise<void>
  /** Rejects vectors computed from a body that changed or was deleted during embedding. */
  updateEmbedding: (id: string, revision: number, vector: number[], metadata: MemoryEmbeddingMetadata) => Promise<void>
  /** The callback must perform only database work. A rejection rolls back facts and receipts together. */
  transaction: <T>(action: (repository: MemoryInteractionRepository) => Promise<T>) => Promise<T>
}

/** Database IO boundary. Transactions use a dedicated connection to avoid unrelated statements joining the commit. */
export interface MemoryDbExecutor {
  execute: (query: string) => Promise<unknown>
}

/** Supplied by the database owner, which serializes transactions against checkpoint and restore. */
export type MemoryDbTransaction = <T>(action: (executor: MemoryDbExecutor) => Promise<T>) => Promise<T>

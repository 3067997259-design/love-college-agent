import type { Clock } from '../../clock'
import type { MemoryDatabaseClient } from '../storage/client'
import type { MemoryRuntimeState } from '../storage/state'
import type { MemoryCommitCoordinator } from '../storage/commits'
import type { MemoryInteractionRepository } from './repository/interaction-repository'
import type { MemoryDreamAgent, MemoryHostPort } from './runtime'
import type { MemoryEmbeddingMetadata, MemoryEmbeddingQueryMetadata, MemoryScope } from './core'

/** IO seams extracted from the Pinia store; no Vue, DOM, localStorage or OPFS. */
export interface MemoryEmbeddingRuntime {
  configure(): Promise<boolean>
  activeMemoryEmbeddingFingerprint(): string
  activeMemoryEmbeddingMetadata(input: { kind: 'document'; dimensions: number }): MemoryEmbeddingMetadata
  activeMemoryEmbeddingMetadata(input: { kind: 'query'; dimensions: number }): MemoryEmbeddingQueryMetadata
  activeMemoryEmbeddingUsage(): { promptTokens: number; totalTokens: number } | undefined
  embedMemoryText(text: string, kind?: 'query' | 'document'): Promise<number[]>
}

export interface AiriMemoryPorts {
  clock: Clock
  state: MemoryRuntimeState
  scope(): MemoryScope
  isOwner(): boolean
  effectsHeld(): boolean
  waitForRestore(): Promise<void>
  openDatabase(): Promise<MemoryDatabaseClient>
  /** Original repository seam permits upstream tests; production uses the DuckDB repository. */
  repository?(database: MemoryDatabaseClient): MemoryInteractionRepository
  /** Required by the LCA engine; omitted only by original upstream fixtures. */
  commits?(): MemoryCommitCoordinator
  embedding: MemoryEmbeddingRuntime
  mirror?: MemoryHostPort
  dreamAgent?: MemoryDreamAgent
  journal(sessionId: string, event: Record<string, unknown>): void
  /** Empty by default; LCA never inherits AIRI's automatic anonymous-user link. */
  linkedUserIds?(scope: MemoryScope): string[]
}

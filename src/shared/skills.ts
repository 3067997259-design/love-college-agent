import type { PublicError } from './state'

/** Metadata only. Skill bodies and absolute filesystem locations stay in main / DSH. */
export interface SkillView {
  id: string
  name: string
  description: string
  source: 'project-dsh' | 'project-agents' | 'profile' | 'extension'
  sourceLabel: string
  status: 'available' | 'shadowed' | 'invalid' | 'missing'
  modelInvocable: boolean
  userInvocable: boolean
  fingerprint: string
  removable: boolean
}
export interface SkillsView {
  status: 'unavailable' | 'loading' | 'ready' | 'failed'
  projectKey: string
  items: readonly SkillView[]
  operation: { id: string; action: 'import' | 'remove'; phase: 'preparing' | 'awaiting-approval' | 'settled'; outcome: 'pending' | 'succeeded' | 'cancelled' | 'failed' } | null
  error: PublicError | null
}
export type SkillCommand =
  | { type: 'skills.refresh' }
  | { type: 'skills.import'; scope: 'profile' | 'project' }
  | { type: 'skills.remove'; skillId: string; fingerprint: string; projectKey: string }
  | { type: 'skills.cancel'; operationId: string }

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { DSH_PROTOCOL_VERSION, type DshOrigin, type DshRootBinding } from '../../shared/dsh-protocol'
import type { AgentAddress, AgentTarget } from '../../shared/collaboration'

const id = z.string().min(1).max(160)
export const agentAddressSchema = z.strictObject({ runtimeId: id, projectId: id, rootSessionId: id, sessionId: id, parentSessionId: id.nullable() })
export const agentTargetSchema = z.strictObject({ address: agentAddressSchema, expectedRevision: z.number().int().nonnegative() })
const originSchema = agentAddressSchema.extend({ protocolVersion: z.literal(DSH_PROTOCOL_VERSION), cwd: z.string().min(1).max(4096) })
const pathKey = (cwd: string) => {
  let path = resolve(cwd)
  try { path = realpathSync.native(path) } catch { /* startup/tests may reserve a not-yet-created directory */ }
  return process.platform === 'win32' ? path.toLowerCase() : path
}
const same = (a: AgentAddress, b: AgentAddress) => a.runtimeId === b.runtimeId && a.projectId === b.projectId && a.rootSessionId === b.rootSessionId && a.sessionId === b.sessionId && a.parentSessionId === b.parentSessionId

/** One host lifetime; only main can reserve roots. Descendants cannot select their own project.
 * Returning a copy prevents a callback or renderer-shaped object from changing the authority map. */
export function createDshIdentities(runtimeId: string = randomUUID()) {
  const projects = new Map<string, string>()
  const members = new Map<string, DshOrigin>()
  const revisions = new Map<string, number>()
  const validate = (input: unknown): DshOrigin | null => {
    const parsed = originSchema.safeParse(input)
    if (!parsed.success) return null
    const origin = parsed.data, known = members.get(origin.sessionId)
    return known && same(known, origin) && pathKey(origin.cwd) === pathKey(known.cwd) ? { ...known } : null
  }
  return {
    runtimeId,
    reserveRoot(sessionId: string, cwd: string): DshRootBinding {
      const canonical = pathKey(cwd)
      let projectId = projects.get(canonical)
      if (!projectId) { projectId = randomUUID(); projects.set(canonical, projectId) }
      const binding = { protocolVersion: DSH_PROTOCOL_VERSION, runtimeId, projectId, cwd: canonical }
      const origin = { ...binding, rootSessionId: sessionId, sessionId, parentSessionId: null }
      if (members.has(sessionId) && !validate(origin)) throw new Error('DSH_IDENTITY_CONFLICT')
      members.set(sessionId, origin); revisions.set(sessionId, 0)
      return binding
    },
    register(input: unknown): DshOrigin | null {
      const parsed = originSchema.safeParse(input)
      if (!parsed.success) return null
      const origin = parsed.data
      if (origin.runtimeId !== runtimeId) return null
      if (members.has(origin.sessionId)) return validate(origin)
      const parent = origin.parentSessionId ? members.get(origin.parentSessionId) : null
      const root = members.get(origin.rootSessionId)
      if (!parent || !root || root.parentSessionId !== null || parent.rootSessionId !== root.sessionId || origin.projectId !== root.projectId || pathKey(origin.cwd) !== pathKey(root.cwd)) return null
      members.set(origin.sessionId, { ...origin, cwd: root.cwd }); revisions.set(origin.sessionId, 0)
      return { ...members.get(origin.sessionId)! }
    },
    validate,
    address(sessionId: string): AgentAddress | null {
      const origin = members.get(sessionId)
      if (!origin) return null
      const { runtimeId, projectId, rootSessionId, parentSessionId } = origin
      return { runtimeId, projectId, rootSessionId, sessionId, parentSessionId }
    },
    /** Control revision follows activation/availability, not every token or activity update. */
    setRevision(sessionId: string, revision: number) {
      if (!members.has(sessionId) || !Number.isSafeInteger(revision) || revision < (revisions.get(sessionId) ?? 0)) return false
      revisions.set(sessionId, revision); return true
    },
    acceptsTarget(input: AgentTarget, activeProjectId: string): boolean {
      const parsed = agentTargetSchema.safeParse(input)
      if (!parsed.success) return false
      const { address, expectedRevision } = parsed.data, known = members.get(address.sessionId)
      return !!known && same(known, address) && address.projectId === activeProjectId && revisions.get(address.sessionId) === expectedRevision
    },
    forgetRoot(rootSessionId: string) {
      for (const [id, origin] of members) if (origin.rootSessionId === rootSessionId) { members.delete(id); revisions.delete(id) }
    },
    clear() { members.clear(); revisions.clear() },
  }
}

import { z } from 'zod'
import { agentTargetSchema } from '../dsh/identity'

/** Closed vocabulary even before consumers are installed. Native preparation issues opaque ids;
 * no extension RPC, filesystem path, tool result or child transcript is accepted here. */
export function v12CommandSchemas(envelope: { protocolVersion: z.ZodLiteral<1>; requestId: z.ZodString; epoch: z.ZodString }) {
  const id = z.string().min(1).max(160)
  const revision = z.number().int().nonnegative()
  return [
    z.strictObject({ ...envelope, type: z.literal('skills.refresh') }),
    z.strictObject({ ...envelope, type: z.literal('skills.import'), scope: z.enum(['profile', 'project']) }),
    z.strictObject({ ...envelope, type: z.literal('skills.remove'), skillId: id, fingerprint: id, projectKey: id }),
    z.strictObject({ ...envelope, type: z.literal('skills.cancel'), operationId: id }),
    z.strictObject({ ...envelope, type: z.literal('extension.pick') }),
    z.strictObject({ ...envelope, type: z.literal('extension.refresh') }),
    z.strictObject({ ...envelope, type: z.literal('extension.restart') }),
    z.strictObject({ ...envelope, type: z.literal('extension.install'), proposalId: id, fingerprint: id }),
    ...(['extension.enable', 'extension.disable', 'extension.remove'] as const).map((type) => z.strictObject({ ...envelope, type: z.literal(type), extensionId: id, expectedRevision: revision, fingerprint: id })),
    ...(['extension.cancel', 'extension.reconcile'] as const).map((type) => z.strictObject({ ...envelope, type: z.literal(type), operationId: id, expectedRevision: revision })),
    z.strictObject({ ...envelope, type: z.literal('agent.message'), target: agentTargetSchema, text: z.string().trim().min(1).max(8000) }),
    ...(['agent.interrupt', 'agent.stop-family'] as const).map((type) => z.strictObject({ ...envelope, type: z.literal(type), target: agentTargetSchema })),
    z.strictObject({ ...envelope, type: z.literal('team.task.update'), target: agentTargetSchema, taskId: id, expectedTaskRevision: revision, action: z.enum(['claim', 'release', 'complete', 'reopen']) }),
  ]
}

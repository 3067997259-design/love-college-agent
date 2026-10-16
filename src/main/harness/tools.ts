import { z } from 'zod'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { ModelTool } from '../model/types'
import type { JournalInput } from '../journal/schema'
import manifest from './tools.json'

export interface ToolContext { clock: Clock; store: SessionStore; turnId: string; signal: AbortSignal }
type JsonValue = Extract<JournalInput, { type: 'tool/result' }>['raw']
export interface ToolResult { ok: boolean; raw: JsonValue; visible: JsonValue; imageRefs?: string[]; fields?: Record<string, string | number | boolean> }
export interface HarnessTool {
  definition: ModelTool
  templateId: string
  validate(input: Record<string, unknown>): boolean
  run(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}
const planSchema = z.strictObject({ steps: z.array(z.strictObject({
  id: z.string().min(1).max(128), text: z.string().min(1).max(500), status: z.enum(['pending', 'active', 'done', 'failed']),
})).max(30) })

/** Only deterministic built-ins for this minimal loop. No arbitrary external plugin code is loaded. */
export function builtinTools(): HarnessTool[] {
  return [
    { definition: manifest[0], templateId: 'clock.read', validate: (input) => z.strictObject({}).safeParse(input).success,
      run: async (_input, { clock, signal }) => {
        signal.throwIfAborted()
        const value = { nowMs: clock.nowMs(), iso: clock.iso(clock.nowMs()) }
        return { ok: true, raw: value, visible: value }
      } },
    { definition: manifest[1], templateId: 'plan.update', validate: (input) => planSchema.safeParse(input).success,
      run: async (input, { store, turnId, signal }) => {
        signal.throwIfAborted()
        store.append({ type: 'plan/update', turnId, steps: planSchema.parse(input).steps })
        return { ok: true, raw: { updated: true }, visible: { updated: true } }
      } },
  ]
}

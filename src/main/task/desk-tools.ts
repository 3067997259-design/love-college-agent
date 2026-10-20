import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { HarnessTool } from '../harness/tools'
import type { SessionStore } from '../store/session'
import { deskPathSchema, validateDeskText } from '../legacy-flow/desk'
import instructions from '../heart-flow/instructions.json'

type Desk = { read(path: string): string | null; write(path: string, value: string | null): void; list(): { path: string; byteLength: number }[] }

/**
 * D2 task-scoped desk tools. Reads are always allowed inside the managed desk. Writes, edits and
 * deletes require the task currently in hand to have an approved plan version, and are refused in a
 * degraded turn (third-party originals in the request): degraded turns cannot use, create or expand
 * task authorization. Each write records a durable `desk/change` with the task id before touching disk.
 */
export function taskDeskTools(options: { store: SessionStore; desk: Desk; authorized: () => boolean; degraded: (turnId: string) => boolean; changed?: () => void }): HarnessTool[] {
  const { store, desk } = options
  const write = (turnId: string, path: string, text: string | null) => {
    if (options.degraded(turnId)) throw new Error('DEGRADED_SOURCE_REQUIRES_APPROVAL')
    if (!options.authorized()) throw new Error('TASK_NOT_APPROVED')
    deskPathSchema.parse(path); validateDeskText(text)
    const taskId = store.projection().activeTaskId; if (!taskId) throw new Error('TASK_NOT_APPROVED')
    const before = desk.read(path); const id = randomUUID()
    store.append({ type: 'desk/change', id, taskId, path, before, after: text, pending: true })
    try { desk.write(path, text) } catch { store.append({ type: 'desk/settled', id, status: 'failed' }); throw new Error('DESK_WRITE_FAILED') }
    store.append({ type: 'desk/settled', id, status: 'applied' }); options.changed?.(); return id
  }
  const spec = { path: deskPathSchema, text: z.string().max(64_000) }
  const entries = [
    { name: 'desk_read', schema: z.strictObject({ path: spec.path }), run: (input: { path: string }) => ({ text: desk.read(input.path) }) },
    { name: 'desk_write', schema: z.strictObject(spec), run: (input: { path: string; text: string }, turnId: string) => ({ changeId: write(turnId, input.path, input.text) }) },
    { name: 'desk_edit', schema: z.strictObject({ path: spec.path, oldText: z.string().min(1).max(64000), newText: z.string().max(64000) }), run: (input: { path: string; oldText: string; newText: string }, turnId: string) => { const text = desk.read(input.path); if (text === null || text.split(input.oldText).length !== 2) throw new Error('EXACT_MATCH_REQUIRED'); return { changeId: write(turnId, input.path, text.replace(input.oldText, input.newText)) } } },
    { name: 'desk_find', schema: z.strictObject({ contains: z.string().max(100) }), run: (input: { contains: string }) => ({ files: desk.list().filter((file) => file.path.includes(input.contains)).slice(0, 100) }) },
    { name: 'desk_grep', schema: z.strictObject({ text: z.string().min(1).max(100) }), run: (input: { text: string }) => ({ matches: desk.list().filter((file) => file.byteLength <= 64000).slice(0, 100).flatMap((file) => { try { return desk.read(file.path)?.includes(input.text) ? [file.path] : [] } catch { return [] } }) }) },
  ]
  return entries.map((entry) => ({
    definition: { name: entry.name, description: instructions.tools[entry.name as keyof typeof instructions.tools], parameters: z.toJSONSchema(entry.schema) },
    templateId: entry.name,
    validate: (input) => entry.schema.safeParse(input).success,
    run: async (input, context) => {
      context.signal.throwIfAborted()
      try { const output = entry.run(input as never, context.turnId); return { ok: true, raw: output, visible: output } }
      catch (error) {
        const code = error instanceof Error ? error.message : 'DESK_FAILED'
        return { ok: false, raw: { error: code }, visible: { error: code } }
      }
    },
  }))
}

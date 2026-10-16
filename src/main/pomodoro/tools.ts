import { z } from 'zod'
import type { HarnessTool } from '../harness/tools'
import type { PomodoroPlanInput } from '../../shared'
import type { PomodoroService } from './service'
import { planSchema } from './schema'
import definitions from './tools.json'

export function pomodoroTools(timer: PomodoroService): HarnessTool[] {
  const validators = [planSchema, z.strictObject({ planId: z.string().min(1).max(128) }), z.strictObject({}), z.strictObject({}), z.strictObject({})]
  return definitions.map((definition, index) => ({ definition, templateId: `pomodoro.${definition.name}`,
    validate: (input) => validators[index].safeParse(input).success,
    run: async (input, { signal }) => {
      signal.throwIfAborted()
      const error = index === 0 ? timer.propose(input as unknown as PomodoroPlanInput, 'assistant')
        : index === 1 ? timer.start(input.planId as string) : index === 2 ? timer.pause() : index === 3 ? timer.stop() : undefined
      if (error) return { ok: false, raw: { error }, visible: { error } }
      const view = JSON.parse(JSON.stringify(timer.read())) as Record<string, never>
      return { ok: true, raw: view, visible: view }
    },
  }))
}

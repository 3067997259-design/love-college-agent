import { z } from 'zod'
import type { HarnessTool } from '../harness/tools'
import type { AppCommand, PublicErrorCode } from '../../shared'
import type { LifeService } from './service'

/**
 * Her own days are hers to move. When the conversation reaches "go out for a while" or "today is a
 * work day", she changes her own state through these tools instead of telling the user to press a
 * button in a panel. They only reach the same dispatch the book's UI uses; permissions do not widen.
 */
const place = z.enum(['coast', 'swing', 'bookstore', 'cafe', 'rooftop', 'store'])
const outingInput = z.strictObject({ action: z.enum(['propose', 'depart', 'return']), place: place.optional() })
const scheduleInput = z.strictObject({ schedule: z.enum(['auto', 'work', 'rest']) })

const rejection: Record<string, string> = {
  unavailable: '现在不能这样安排（可能在忙、在专注、正在外面，或者今天的提议还没结束）。',
  'invalid-command': '这个操作没有被接受。',
}
type Visible = Record<string, string | number | boolean | null>

export function lifeTools(life: LifeService): HarnessTool[] {
  const dispatch = (body: Record<string, unknown>): PublicErrorCode | undefined => life.dispatch({ ...body, protocolVersion: 1, requestId: 'life-tool', epoch: 'life-tool' } as AppCommand)
  return [
    {
      definition: {
        name: 'life_outing',
        description: 'Move her own day: propose a short outing to a place, leave for a proposed outing, or come back early. Use it when the user suggests she goes out, or when she genuinely wants some air. She keeps her own life; do not promise it in words without calling this tool.',
        parameters: { type: 'object', required: ['action'], additionalProperties: false, properties: {
          action: { type: 'string', enum: ['propose', 'depart', 'return'], description: 'propose a new outing, leave for the pending proposal, or return from the current one' },
          place: { type: 'string', enum: ['coast', 'swing', 'bookstore', 'cafe', 'rooftop', 'store'], description: 'only with propose; defaults to the coast or the swing' },
        } },
      },
      templateId: 'life.outing',
      validate: (input) => outingInput.safeParse(input).success,
      run: async (input) => {
        const value = outingInput.parse(input)
        let code: PublicErrorCode | undefined
        if (value.action === 'propose') code = dispatch({ type: 'life.propose', ...(value.place ? { place: value.place } : {}) })
        else if (value.action === 'depart') {
          const pending = [...life.view().outings].reverse().find((outing) => outing.status === 'proposed')
          code = pending ? dispatch({ type: 'life.depart', outingId: pending.id }) : 'unavailable'
        } else code = dispatch({ type: 'life.return' })
        const view = life.view()
        const current = [...view.outings].reverse().find((outing) => outing.status === 'away' || outing.status === 'proposed')
        const visible: Visible = code ? { ok: false, reason: rejection[code] ?? rejection.unavailable }
          : { ok: true, locationId: view.locationId, outing: current ? JSON.stringify({ place: current.place, status: current.status, returnsAtMs: current.returnsAtMs }) : null }
        return { ok: true, raw: visible, visible }
      },
    },
    {
      definition: {
        name: 'life_schedule',
        description: 'Mark how today goes for the two of you: she keeps her own routine under auto, stays in while the user works, or keeps the day free on a rest day. Only when the user says so or clearly implies it.',
        parameters: { type: 'object', required: ['schedule'], additionalProperties: false, properties: { schedule: { type: 'string', enum: ['auto', 'work', 'rest'] } } },
      },
      templateId: 'life.schedule',
      validate: (input) => scheduleInput.safeParse(input).success,
      run: async (input) => {
        const value = scheduleInput.parse(input)
        const code = dispatch({ type: 'life.schedule', schedule: value.schedule })
        const visible: Visible = code ? { ok: false, reason: rejection[code] ?? rejection.unavailable } : { ok: true, schedule: value.schedule }
        return { ok: true, raw: visible, visible }
      },
    },
  ]
}

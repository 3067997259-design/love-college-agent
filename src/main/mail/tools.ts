import { z } from 'zod'
import type { HarnessTool, ToolResult } from '../harness/tools'
import type { CampusService } from '../campus/service'
import { mailFactsSchema } from '../campus/schema'
import definitions from './tools.json'

export function mailTools(service: CampusService): HarnessTool[] {
  return definitions.map((definition, index) => ({ definition, templateId: index === 0 ? 'mail.check' : 'mail.read',
    validate: (input) => z.strictObject({}).safeParse(input).success,
    run: async (_input, { signal }): Promise<ToolResult> => {
      signal.throwIfAborted()
      if (index === 0) {
        const result = await service.scanNow(signal)
        const value = JSON.parse(JSON.stringify(result)) as Record<string, never>
        return { ok: result.ok, raw: value, visible: value, fields: result.ok ? { newCount: result.newCount ?? 0 } : {} }
      }
      const items = service.candidates().map((candidate) => ({ ...mailFactsSchema.parse({ candidateId: candidate.id, revision: candidate.revision,
        title: candidate.title, kind: candidate.kind, deadlineIso: candidate.deadlineIso, eventStartIso: candidate.eventStartIso, eventEndIso: candidate.eventEndIso,
        locationText: candidate.locationText, sourceLabel: candidate.sourceLabel, source: candidate.source, trust: 'untrusted' }), status: candidate.status }))
      const value = JSON.parse(JSON.stringify({ items })) as Record<string, never>
      return { ok: true, raw: value, visible: value }
    },
  }))
}

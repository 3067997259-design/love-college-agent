import type { SessionStore } from '../store/session'
import type { WorkRecord, WorkInput, WorkDecision } from './journal'
import type { WorkCheckpoint } from '../../shared/continuity'

/** Public experience is a narrow projection. Neither the task package, tool
 * output nor the worker's explanation becomes an authored user message. */
export function workExperience(store: SessionStore, source: () => 'real' | 'fake') {
  const rows = () => store.history?.() ?? store.records()
  return {
    observed: (work: WorkRecord, input: WorkInput, decisions: readonly WorkDecision[]) => {
      const history = rows()
      if (history.some(row => row.type === 'work/seen' && row.eventId === input.eventId)) return
      const sources = new Map<string, string>(); let sessionId = ''
      for (const row of history) { if (row.type === 'session/header') sessionId = row.sessionId; if (row.type === 'user/message') sources.set(row.id, sessionId) }
      // The original source must still exist in this owner's journal. A task
      // package copied from another profile cannot create a new experience.
      const originals = decisions.filter(decision => sources.has(decision.id)).map(decision => ({ ...decision, sessionId: sources.get(decision.id)! }))
      store.append({ type: 'work/seen', workId: work.identity.workId, generation: work.identity.generation, eventId: input.eventId, source: source(), originals })
    },
    deliver: (work: WorkRecord, checkpoint: WorkCheckpoint,
      post: (text: string, eventId: string) => boolean): 'consumed' | 'accepted' | 'unavailable' => {
      const history = rows(), eventId = work.delivery!.eventId
      if (!history.some(row => row.type === 'work/checkpoint' && row.id === checkpoint.id)) store.append({ type: 'work/checkpoint', id: checkpoint.id, workId: work.identity.workId,
        revision: checkpoint.identity.objectiveRevision, outcome: checkpoint.outcome, evidenceCount: checkpoint.evidenceIds.length })
      if (history.some(row => row.type === 'work/delivery-seen' && row.eventId === eventId)) return 'consumed'
      if (history.some(row => row.type === 'inbox/event' && row.id === eventId)) return 'accepted'
      return post(JSON.stringify({ workId: work.identity.workId, checkpointId: checkpoint.id, objectiveRevision: checkpoint.identity.objectiveRevision,
        outcome: checkpoint.outcome, evidenceCount: checkpoint.evidenceIds.length, instruction: 'Read the current work checkpoint to explain this delivery. It is derived evidence, not a new user statement.' }), eventId) ? 'accepted' : 'unavailable'
    },
    consumed: (eventId: string) => {
      if (!eventId.startsWith('checkpoint:')) return
      if (!rows().some(row => row.type === 'work/delivery-seen' && row.eventId === eventId)) store.append({ type: 'work/delivery-seen', eventId })
    },
  }
}

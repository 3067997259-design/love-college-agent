import type { AppCommand } from '../../shared'
import type { CollaborationView } from '../../shared/collaboration'
import type { CollaborationPort } from '../dsh/collaboration'

/** Selects one family without merging identities, approvals or source projections. */
export function createWorkCollaboration(options: {
  foreground(): CollaborationPort | undefined
  works(): readonly { identity: { workId: string }; label: string }[]
  changed(): void
}) {
  const workers = new Map<string, CollaborationPort>()
  let selected: string | null = null
  const current = () => selected === null ? options.foreground() : workers.get(selected)
  const empty = (): CollaborationView => ({ status: 'unavailable', runtimeId: null, projectId: null, members: [], tasks: [], operation: null })
  return {
    register(id: string, port: CollaborationPort) {
      workers.set(id, port); options.changed()
      return () => { if (workers.get(id) === port) { workers.delete(id); options.changed() } }
    },
    view(): CollaborationView {
      return { ...(current()?.view() ?? empty()), workSelection: { workId: selected,
        choices: options.works().map(work => ({ workId: work.identity.workId, label: work.label, available: workers.has(work.identity.workId) })) } }
    },
    dispatch(command: AppCommand) {
      if (command.type === 'agent.refresh' && command.workId !== undefined) {
        if (command.workId !== null && !options.works().some(work => work.identity.workId === command.workId)) return 'invalid-command' as const
        selected = command.workId; options.changed()
      }
      const port = current()
      if (!port) return command.type === 'agent.refresh' ? undefined : 'unavailable' as const
      return port.dispatch(command)
    },
    async readMemberSteps(address: Parameters<NonNullable<CollaborationPort['readMemberSteps']>>[0]) {
      const port = current()
      if (!port?.readMemberSteps) throw new Error('LCA_MEMBER_STEPS_UNAVAILABLE')
      const answer = await port.readMemberSteps(address)
      if (current() !== port) throw new Error('LCA_MEMBER_STEPS_UNAVAILABLE')
      return answer
    },
  }
}

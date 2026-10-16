import type { AppCommand, CommandAck } from './commands'
import type { AppEvent } from './events'
import type { AppSnapshot } from './state'

export interface AppBridge {
  getSnapshot(): Promise<AppSnapshot>
  subscribe(listener: (event: AppEvent) => void): () => void
  dispatch(command: AppCommand): Promise<CommandAck>
}

export const IPC_CHANNELS = {
  snapshot: 'lca:snapshot',
  event: 'lca:event',
  command: 'lca:command',
} as const

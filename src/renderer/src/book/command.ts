import type { AppBridge, AppCommand, PublicErrorCode } from '../../../shared'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type CommandBody = DistributiveOmit<AppCommand, 'protocolVersion' | 'requestId' | 'epoch'>
export type CommandResult = { ok: true } | { ok: false; code: PublicErrorCode | 'disconnected' }

/** 发一条白名单命令。accepted 只表示收到，做没做成看后续快照（src/shared/README.md）。 */
export async function sendCommand(bridge: AppBridge, epoch: string, body: CommandBody): Promise<CommandResult> {
  const command = { protocolVersion: 1, requestId: crypto.randomUUID(), epoch, ...body } as AppCommand
  try {
    const ack = await bridge.dispatch(command)
    return ack.status === 'accepted' ? { ok: true } : { ok: false, code: ack.error.code }
  } catch {
    return { ok: false, code: 'disconnected' }
  }
}

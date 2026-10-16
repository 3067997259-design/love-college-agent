import type { AppCommand, McpView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { PrivacyModel } from '../privacy/filter'
import { createMcpConnection, type McpConnection } from './connection'
import { readMcpConfig, saveMcpConfig, type McpConfig } from './config'

export function createMcpService(options: { clock: Clock; configPath: string; source: 'real' | 'fake'; privacyModel: PrivacyModel | null;
  developmentConfig?: McpConfig; chooseConfig(): Promise<string | null>; changed(): void; canConfigure(): boolean }) {
  let connections = new Map<string, McpConnection>(); let error: McpView['error']; let enabled = true; let disposed = false; let worker: Promise<void> | undefined
  const jobs = new Set<Promise<void>>()
  const install = (config: McpConfig) => { connections = new Map(Object.entries(config.mcpServers).filter(([, value]) => !value.disabled).map(([id, config]) => [id,
    createMcpConnection({ id, config, clock: options.clock, source: options.source, privacyModel: options.privacyModel, changed: options.changed })])) }
  try { install(options.developmentConfig ?? readMcpConfig(options.configPath)) } catch { error = { code: 'configuration-failed', retryable: true } }
  const disconnect = async () => { await Promise.all([...connections.values()].map((connection) => connection.disconnect())) }
  const track = (promise: Promise<void>) => { jobs.add(promise); void promise.finally(() => jobs.delete(promise)) }
  return {
    view: (): McpView => ({ servers: [...connections.values()].map((connection) => connection.view()), ...(error ? { error } : {}) }),
    tools: () => enabled && !disposed ? [...connections.values()].flatMap((connection) => connection.tools()) : [],
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (!enabled || disposed) return 'unavailable'
      if (command.type === 'mcp.configure') {
        if (options.developmentConfig || worker || !options.canConfigure()) return 'unavailable'
        worker = (async () => {
          const path = await options.chooseConfig(); if (!path || disposed) return
          const config = readMcpConfig(path); await disconnect(); if (disposed) return
          saveMcpConfig(options.configPath, config); install(config); error = undefined
        })().catch(() => { error = { code: 'configuration-failed', retryable: true } }).finally(() => { worker = undefined; options.changed() }); return
      }
      if (command.type !== 'mcp.connect' && command.type !== 'mcp.disconnect') return 'invalid-command'
      const connection = connections.get(command.serverId); if (!connection) return 'invalid-command'
      if (command.type === 'mcp.connect') {
        if (worker || command.fingerprint !== connection.view().fingerprint) return 'permission-denied'
        track(connection.connect())
      } else track(connection.disconnect())
    },
    setEnabled: (value: boolean) => { enabled = value; if (!value) track(disconnect()); options.changed() },
    idle: async () => { await worker; await Promise.all([...jobs]) },
    close: async () => { disposed = true; await disconnect(); await worker; await Promise.all([...jobs]) },
  }
}
export type McpService = ReturnType<typeof createMcpService>

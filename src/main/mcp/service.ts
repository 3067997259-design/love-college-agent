import type { AppCommand, McpView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { PrivacyModel } from '../privacy/filter'
import { createMcpConnection, type McpConnection } from './connection'
import { readMcpConfig, saveMcpConfig, type McpConfig, type McpConfigEntry } from './config'

export function createMcpService(options: { clock: Clock; configPath: string; source: 'real' | 'fake'; privacyModel: PrivacyModel | null;
  developmentConfig?: McpConfig; chooseConfig(): Promise<string | null>; confirmConnection(id: string, config: McpConfigEntry): Promise<boolean>; changed(): void; canConfigure(): boolean;
  beforeDisconnect?(serverId: string): Promise<void> }) {
  let connections = new Map<string, McpConnection>(); let error: McpView['error']; let enabled = true; let disposed = false; let worker: Promise<void> | undefined
  let privateConfig: McpConfig = { mcpServers: {} }; const approving = new Map<string, symbol>()
  const jobs = new Set<Promise<void>>()
  const disconnecting = new Set<string>()
  const install = (config: McpConfig) => { privateConfig = config; connections = new Map(Object.entries(config.mcpServers).filter(([, value]) => !value.disabled).map(([id, config]) => [id,
    createMcpConnection({ id, config, clock: options.clock, source: options.source, privacyModel: options.privacyModel, changed: options.changed })])) }
  try { install(options.developmentConfig ?? readMcpConfig(options.configPath)) } catch { error = { code: 'configuration-failed', retryable: true } }
  const disconnect = async () => { await Promise.all([...connections.values()].map((connection) => connection.disconnect())) }
  const track = (promise: Promise<void>) => { jobs.add(promise); void promise.finally(() => jobs.delete(promise)) }
  return {
    view: (): McpView => ({ servers: [...connections.values()].map((connection) => connection.view()), ...(error ? { error } : {}) }),
    // Game endpoints only enter the bounded game adapter; ordinary chat cannot bypass round consent
    // through a generic MCP alias, including before a game round has been selected.
    tools: (excludeServers: readonly string[] = []) => enabled && !disposed ? [...connections].filter(([id, connection]) => !excludeServers.includes(id)
      && !connection.view().tools.some((name) => name === 'get_world_session' || name === 'navigate_to')).flatMap(([, connection]) => connection.tools()) : [],
    /** Main-only typed adapters; not a renderer/debug API or an alternate unfiltered model-tool path. */
    protocol: (serverId: string) => enabled && !disposed && connections.get(serverId)?.view().status === 'ready' ? connections.get(serverId)?.protocol : undefined,
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (!enabled || disposed) return 'unavailable'
      if (command.type === 'mcp.configure') {
        if (options.developmentConfig || worker || approving.size || disconnecting.size || !options.canConfigure()) return 'unavailable'
        worker = (async () => {
          const path = await options.chooseConfig(); if (!path || disposed) return
          const config = readMcpConfig(path); await disconnect(); if (disposed) return
          saveMcpConfig(options.configPath, config); install(config); error = undefined
        })().catch(() => { error = { code: 'configuration-failed', retryable: true } }).finally(() => { worker = undefined; options.changed() }); return
      }
      if (command.type !== 'mcp.connect' && command.type !== 'mcp.disconnect') return 'invalid-command'
      const connection = connections.get(command.serverId); if (!connection) return 'invalid-command'
      if (command.type === 'mcp.connect') {
        if (worker || disconnecting.has(command.serverId) || approving.has(command.serverId) || command.fingerprint !== connection.view().fingerprint) return 'permission-denied'
        if (connection.view().status === 'ready' || connection.view().status === 'connecting') return
        const id = command.serverId; const approval = Symbol(); approving.set(id, approval)
        track((async () => {
          if (await options.confirmConnection(id, privateConfig.mcpServers[id]) && approving.get(id) === approval && enabled && !disposed && connections.get(id) === connection) await connection.connect()
        })().catch(() => { error = { code: 'connection-failed', retryable: true } }).finally(() => { if (approving.get(id) === approval) approving.delete(id); options.changed() }))
      } else {
        const id = command.serverId; approving.delete(id); if (disconnecting.has(id)) return
        disconnecting.add(id)
        track((async () => {
          try { await options.beforeDisconnect?.(id) }
          catch { error = { code: 'unavailable', retryable: true } }
          finally { await connection.disconnect(); disconnecting.delete(id); options.changed() }
        })())
      }
    },
    setEnabled: (value: boolean) => { enabled = value; if (!value) { approving.clear(); track(disconnect()) }; options.changed() },
    idle: async () => { await worker; await Promise.all([...jobs]) },
    close: async () => { disposed = true; await disconnect(); await worker; await Promise.all([...jobs]) },
  }
}
export type McpService = ReturnType<typeof createMcpService>

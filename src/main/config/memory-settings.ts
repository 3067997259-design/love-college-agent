import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { AppCommand, MemorySettingsView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { createAiriMemoryRuntime } from '../memory/airi/runtime'
import { createApiMemoryEmbeddingSource, type MemoryEmbeddingSource } from '../memory/airi/embedding'
import { maskedHost } from './vendors'

const embeddingInput = z.strictObject({ baseUrl: z.string().min(1).max(4096), apiKey: z.string().min(1).max(8192).optional(), model: z.string().min(1).max(256) })
const mirrorInput = z.strictObject({ connectionString: z.string().min(1).max(8192).optional(), enabled: z.boolean() })
export const memorySettingsCommands = [
  z.strictObject({ type: z.literal('memory.settings.configure'), embedding: embeddingInput.nullable().optional(), mirror: mirrorInput.nullable().optional() }),
  z.strictObject({ type: z.literal('memory.settings.retry'), target: z.enum(['embedding', 'mirror']) }),
  z.strictObject({ type: z.literal('memory.settings.interaction'), directoryEnabled: z.boolean(), toolsEnabled: z.boolean() }),
] as const
const configSchema = z.strictObject({ version: z.literal(1),
  embedding: embeddingInput.extend({ apiKey: z.string().min(1).max(8192) }).optional(),
  mirror: mirrorInput.extend({ connectionString: z.string().min(1).max(8192) }).optional(),
})
type Config = z.infer<typeof configSchema>
type Runtime = ReturnType<typeof createAiriMemoryRuntime>

/** Private connection configuration, deliberately outside every archive allowlist.
 * Read-only projections and failures use fixed vocabulary; secrets are write-only. */
export function createMemorySettings(options: {
  root: string; clock: Clock; runtime(): Runtime; canConfigure(): boolean; held(): boolean
  prepare(): Promise<void>; changed(): void
  reserve?(units: number): void
  source?(input: { baseUrl: string; apiKey: string; model: string; clock: Clock }): MemoryEmbeddingSource
}) {
  const folder = join(options.root, 'connections'); const path = join(folder, 'memory.json')
  let config: Config = { version: 1 }; let source: MemoryEmbeddingSource | undefined
  let worker: Promise<void> | undefined; let disposed = false; let invalidFile = false
  let status: MemorySettingsView['status'] = 'idle'; let error: MemorySettingsView['error']
  const validate = (value: Config) => {
    if (value.embedding) {
      const base = new URL(value.embedding.baseUrl)
      if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
        || !value.embedding.apiKey.trim() || !value.embedding.model.trim()) throw new Error('MEMORY_CONFIGURATION_INVALID')
    }
    if (value.mirror && !['postgres:', 'postgresql:'].includes(new URL(value.mirror.connectionString).protocol)) throw new Error('MEMORY_CONFIGURATION_INVALID')
    return value
  }
  const installSource = () => {
    const installed = config.embedding ? (options.source ?? createApiMemoryEmbeddingSource)({ ...config.embedding, clock: options.clock }) : undefined
    source = installed && { ...installed, embed: async (text, kind) => {
      if (disposed || options.held() || source?.fingerprint !== installed.fingerprint) throw new Error('MEMORY_EMBEDDING_HELD')
      // Reserve conservatively before each outbound call, including migration.
      options.reserve?.(Buffer.byteLength(text, 'utf8') + 2048)
      const vector = await installed.embed(text, kind)
      if (disposed || options.held() || source?.fingerprint !== installed.fingerprint) throw new Error('MEMORY_EMBEDDING_HELD')
      return vector
    } }
  }
  try {
    if (existsSync(path)) {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64_000 || realpathSync(path) !== resolve(path)) throw new Error('MEMORY_CONFIGURATION_INVALID')
      config = validate(configSchema.parse(JSON.parse(readFileSync(path, 'utf8'))))
    }
    installSource()
  } catch { invalidFile = true; status = 'failed'; error = 'configuration' }
  const write = (next: Config) => {
    mkdirSync(folder, { recursive: true })
    if (lstatSync(folder).isSymbolicLink() || realpathSync(folder) !== resolve(folder)
      || existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).nlink !== 1)) throw new Error('MEMORY_CONFIGURATION_INVALID')
    const temporary = `${path}.${randomUUID()}.tmp`; const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
  }
  const run = (action: () => Promise<void>, failure: NonNullable<MemorySettingsView['error']>) => {
    status = 'saving'; error = undefined
    worker = Promise.resolve().then(action).catch(() => { status = 'failed'; error = failure }).finally(() => {
      worker = undefined; if (status !== 'failed') status = 'idle'; options.changed()
    })
    options.changed()
  }
  const mirror = async () => {
    const runtime = options.runtime()
    runtime.longTermSyncEnabled.value = config.mirror?.enabled === true
    const result = await runtime.configureRemoteHost(config.mirror?.enabled ? config.mirror.connectionString : '')
    if (config.mirror?.enabled && result.status !== 'ready') throw new Error('MEMORY_MIRROR_UNAVAILABLE')
    if (config.mirror?.enabled) await runtime.queueExistingLongTermMemories()
  }
  return {
    source: () => source,
    /** Main-only, for the existing archive credential leak guard. */
    credentials: () => {
      const password = config.mirror ? new URL(config.mirror.connectionString).password : undefined
      let decoded = password; try { if (password) decoded = decodeURIComponent(password) } catch { /* URL may contain a literal percent. */ }
      return [config.embedding?.apiKey, config.mirror?.connectionString, password, decoded].filter((value): value is string => !!value)
    },
    view: (): MemorySettingsView => ({ status, embedding: { configured: !!config.embedding, model: config.embedding?.model ?? null, host: config.embedding ? maskedHost(config.embedding.baseUrl) : null },
      mirror: { configured: !!config.mirror, enabled: config.mirror?.enabled === true },
      interaction: { directoryEnabled: options.runtime().directoryEnabled.value, toolsEnabled: options.runtime().toolsEnabled.value }, ...(error ? { error } : {}) }),
    initialize: async () => {
      if (invalidFile || disposed) return
      // Storage installation is local. Only an explicitly saved enabled mirror connects.
      options.runtime().longTermSyncEnabled.value = config.mirror?.enabled === true
      if (config.mirror?.enabled) { run(mirror, 'connection'); await worker }
    },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (!command.type.startsWith('memory.settings.')) return 'invalid-command'
      if (disposed || worker || !options.canConfigure()) return 'unavailable'
      if (invalidFile) return 'configuration-failed'
      if (command.type === 'memory.settings.interaction') {
        run(async () => { await options.prepare(); await options.runtime().setInteractionSettings(command) }, 'storage'); return
      }
      if (command.type === 'memory.settings.retry') {
        if (command.target === 'embedding' && !config.embedding || command.target === 'mirror' && !config.mirror?.enabled) return 'not-configured'
        run(async () => { await options.prepare(); if (command.target === 'embedding') await options.runtime().refreshEmbedding(); else await mirror() }, command.target === 'embedding' ? 'embedding' : 'connection'); return
      }
      if (command.type !== 'memory.settings.configure' || command.embedding === undefined && command.mirror === undefined) return 'invalid-command'
      let next: Config
      try {
        next = validate(configSchema.parse({ ...config,
          ...(command.embedding !== undefined ? { embedding: command.embedding === null ? undefined : { ...command.embedding, apiKey: command.embedding.apiKey ?? config.embedding?.apiKey } } : {}),
          ...(command.mirror !== undefined ? { mirror: command.mirror === null ? undefined : { ...command.mirror, connectionString: command.mirror.connectionString ?? config.mirror?.connectionString } } : {}),
        }))
        // Credentials belong to the old endpoint. Changing endpoint without a
        // replacement key must never send that key to a different provider.
        if (command.embedding && !command.embedding.apiKey && config.embedding?.baseUrl !== command.embedding.baseUrl) return 'configuration-failed'
      } catch { return 'configuration-failed' }
      run(async () => {
        await options.prepare(); if (disposed || options.held()) throw new Error('MEMORY_CONFIGURATION_HELD')
        write(next); config = next
        if (command.embedding !== undefined) { installSource(); options.runtime().revoke(); await options.runtime().refreshEmbedding() }
        if (command.mirror !== undefined) await mirror()
      }, command.embedding !== undefined ? 'embedding' : 'connection')
    },
    isBusy: () => !!worker,
    idle: async () => { await worker },
    close: async () => { disposed = true; await worker },
  }
}
export type MemorySettingsService = ReturnType<typeof createMemorySettings>

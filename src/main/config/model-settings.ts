import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { AppCommand, ModelSettingsView, PublicErrorCode } from '../../shared'
import type { ProviderSlot } from './providers'
import { voiceConfigSchema } from '../voice/port'

export const providerConfigPath = (root: string, fallback: string) => existsSync(join(root, 'connections/providers.json')) ? join(root, 'connections/providers.json') : fallback
const entry = z.strictObject({ base_url: z.string().max(4096).default(''), api_key: z.string().max(8192).default(''), model: z.string().max(256).default('') })
const schema = z.strictObject({ providers: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), z.union([entry, voiceConfigSchema])).refine((value) => Object.keys(value).length <= 16 && Object.entries(value).every(([slot, config]) => (slot === 'tts' ? voiceConfigSchema : entry).safeParse(config).success)),
  mail: z.strictObject({ host: z.string().max(256), port: z.number().int().min(1).max(65535), tls: z.literal(true), user: z.string().max(320), auth_code: z.string().max(8192), folder: z.literal('桃子') }).optional() })
export function createModelSettings(options: { root: string; developer: boolean; slots: readonly ProviderSlot[]; canConfigure(): boolean; choose(): Promise<string | null>; changed(): void }) {
  let view: ModelSettingsView = { status: 'idle', configuredSlots: [...options.slots], restartRequired: false }; let worker: Promise<void> | undefined; let disposed = false
  return { view: () => structuredClone(view),
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type !== 'models.configure') return 'invalid-command'
      if (options.developer) return 'permission-denied'
      if (disposed || worker || !options.canConfigure()) return 'unavailable'
      view = { ...view, status: 'selecting' }; delete view.error; options.changed()
      worker = (async () => {
        const file = await options.choose(); if (!file || disposed) { view.status = 'idle'; return }
        const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256_000) throw new Error('MODEL_CONFIGURATION_INVALID')
        const value = schema.parse(JSON.parse(readFileSync(file, 'utf8')))
        for (const config of Object.values(value.providers)) if (config.base_url) { const url = new URL(config.base_url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('MODEL_CONFIGURATION_INVALID') }
        const folder = join(options.root, 'connections'); mkdirSync(folder, { recursive: true }); if (realpathSync(folder) !== resolve(folder) || lstatSync(folder).isSymbolicLink()) throw new Error('MODEL_CONFIGURATION_INVALID')
        const path = join(folder, 'providers.json'); if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw new Error('MODEL_CONFIGURATION_INVALID')
        writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(path + '.tmp', path)
        view = { ...view, status: 'saved', restartRequired: true }
      })().catch(() => { view = { ...view, status: 'failed', error: { code: 'configuration-failed', retryable: true } } }).finally(() => { worker = undefined; options.changed() })
    },
    idle: async () => { await worker }, close: async () => { disposed = true; await worker },
  }
}
export type ModelSettingsService = ReturnType<typeof createModelSettings>

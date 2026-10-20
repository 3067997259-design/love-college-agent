import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { AppCommand, ModelProviderSlot, ModelSettingsView, ModelSlotDetail, PublicErrorCode, ReasoningEffort } from '../../shared'
import { PROVIDER_SLOTS, REASONING_EFFORTS, readModelProviders, inferModelRouting, type ModelEfforts, type ProviderSlot } from './providers'
import { maskedHost, vendorOf } from './vendors'
import { voiceConfigSchema } from '../voice/port'
import type { Clock } from '../clock'
import { createModelClient } from '../model/client'
import { ModelFailure, type ModelFailureKind } from '../model/types'
import { ResourceFailure } from '../resources/ledger'

export const providerConfigPath = (root: string, fallback: string) => existsSync(join(root, 'connections/providers.json')) ? join(root, 'connections/providers.json') : fallback
const entry = z.strictObject({ base_url: z.string().max(4096).default(''), api_key: z.string().max(8192).default(''), model: z.string().max(256).default('') })
const schema = z.strictObject({ providers: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), z.union([entry, voiceConfigSchema])).refine((value) => Object.keys(value).length <= 16 && Object.entries(value).every(([slot, config]) => (slot === 'tts' ? voiceConfigSchema : entry).safeParse(config).success)),
  routing: z.strictObject({ background: z.enum(['follow-main', 'independent']).optional(), privacy: z.enum(['follow-main', 'independent']).optional(), work: z.enum(['follow-main', 'independent']).optional() }).optional(),
  efforts: z.strictObject({ chat: z.enum(REASONING_EFFORTS).optional(), work: z.enum(REASONING_EFFORTS).optional() }).optional(),
  mail: z.strictObject({ host: z.string().max(256), port: z.number().int().min(1).max(65535), tls: z.literal(true), user: z.string().max(320), auth_code: z.string().max(8192), folder: z.literal('桃子') }).optional() })
type Config = z.infer<typeof schema>
// Bootstrap readers historically accept annotated configs. Import and GUI edits must
// accept the same known fields, while persisting only the application's strict shape.
// Keep routing unmodified so a misspelled privacy policy is still rejected.
const fields = (value: unknown, allowed: readonly string[]): unknown => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(allowed.filter((key) => Object.hasOwn(value, key)).map((key) => [key, (value as Record<string, unknown>)[key]])) : value
const parseConfig = (text: string): Config => {
  const raw = z.object({ providers: z.record(z.string(), z.unknown()), mail: z.unknown().optional(), routing: z.unknown().optional(), efforts: z.unknown().optional() }).parse(JSON.parse(text.replace(/^\uFEFF/, '')))
  return schema.parse({ ...raw,
    providers: Object.fromEntries(Object.entries(raw.providers).map(([slot, value]) => [slot, fields(value, slot === 'tts' ? ['base_url', 'api_key', 'model', 'protocol', 'voice'] : ['base_url', 'api_key', 'model'])])),
    ...(Object.hasOwn(raw, 'mail') ? { mail: fields(raw.mail, ['host', 'port', 'tls', 'user', 'auth_code', 'folder']) } : {}),
  })
}
const MODEL_SLOTS = new Set<ModelProviderSlot>(PROVIDER_SLOTS)
const probeCode = (kind: ModelFailureKind): PublicErrorCode => {
  if (kind === 'configuration') return 'configuration-failed'
  if (kind === 'network' || kind === 'timeout' || kind === 'interrupted') return 'connection-failed'
  if (kind === 'quota') return 'quota-exhausted'
  if (kind === 'content-filtered' || kind === 'invalid-output') return 'invalid-model-output'
  if (kind === 'cancelled') return 'operation-cancelled'
  return 'upstream-busy'
}

/** The roles whose thinking level the settings choose: her chat model and her work model. */
const roleOf = (slot: ModelProviderSlot): 'chat' | 'work' | null => slot === 'chat' || slot === 'work' ? slot : null
/** What the book may show about each configured model slot: vendor or masked host, and the model id. */
const detailsOf = (value: Config): Partial<Record<ModelProviderSlot, ModelSlotDetail>> => Object.fromEntries([...MODEL_SLOTS].flatMap((slot) => {
  const config = value.providers[slot]
  return config && 'base_url' in config && config.base_url && config.model ? [[slot, { vendor: vendorOf(config.base_url)?.label ?? null, host: maskedHost(config.base_url), model: config.model }]] : []
}))

export function createModelSettings(options: { root: string; fallback?: string; apply?(): Promise<void>; developer: boolean; slots: readonly ProviderSlot[]; clock: Clock; canConfigure(): boolean; budget?: { reserveModel(units: number, bucket: 'work' | 'autonomous'): void }; choose(): Promise<string | null>; changed(): void
  /** A thinking level changed: DSH applies it from the next step, no restart. */
  effortsChanged?(efforts: ModelEfforts): void }) {
  let view: ModelSettingsView = { status: 'idle', configuredSlots: [...options.slots], restartRequired: false }; let worker: Promise<void> | undefined; let disposed = false
  const path = () => join(options.root, 'connections', 'providers.json')
  const readCurrent = (): Config => {
    const file = options.fallback ? providerConfigPath(options.root, options.fallback) : path()
    if (!existsSync(file)) return { providers: {} }
    const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) throw new Error('MODEL_CONFIGURATION_INVALID')
    return parseConfig(readFileSync(file, 'utf8'))
  }
  const writeCurrent = (value: Config) => {
    const parsed = schema.parse(value)
    const folder = join(options.root, 'connections'); mkdirSync(folder, { recursive: true })
    if (realpathSync(folder) !== resolve(folder) || lstatSync(folder).isSymbolicLink()) throw new Error('MODEL_CONFIGURATION_INVALID')
    const file = path(); if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) throw new Error('MODEL_CONFIGURATION_INVALID')
    writeFileSync(file + '.tmp', JSON.stringify(parsed), { mode: 0o600 }); renameSync(file + '.tmp', file)
  }
  const presence = (value: Config) => ({ tts: !!value.providers.tts, rodin: !!value.providers.rodin, mail: !!value.mail })
  const described = (value: Config) => ({ routing: inferModelRouting(value), details: detailsOf(value), efforts: { ...value.efforts } })
  try { const current = readCurrent(); view = { ...view, services: presence(current), ...described(current) } } catch { view = { ...view, services: { tts: false, rodin: false, mail: false } } }
  const refreshSlots = async () => { const applied = await readModelProviders(path()); const current = readCurrent(); view = { ...view, configuredSlots: [...applied.keys()], services: presence(current), ...described(current) }; delete view.levels; await options.apply?.() }
  const fail = (code: PublicErrorCode) => { view = { ...view, status: 'failed', error: { code, retryable: true } } }
  return { view: () => structuredClone(view), isBusy: () => !!worker,
    /** Levels DSH reported for each role's model (null: unknown). */
    setLevels: (levels: { chat: readonly string[] | null; work: readonly string[] | null } | null) => {
      const known = (list: readonly string[] | null | undefined) => list?.filter((level): level is ReasoningEffort => (REASONING_EFFORTS as readonly string[]).includes(level))
      const chat = known(levels?.chat); const work = known(levels?.work)
      view = { ...view, levels: { ...(chat?.length ? { chat } : {}), ...(work?.length ? { work } : {}) } }
      options.changed()
    },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (options.developer) return 'permission-denied'
      // A thinking level may change mid-work: it applies from her next step and restarts nothing.
      if (disposed || worker || (command.type !== 'models.effort.set' && !options.canConfigure())) return 'unavailable'
      if (command.type === 'models.provider.save') {
        if (!MODEL_SLOTS.has(command.slot)) return 'invalid-command'
        view = { ...view, status: 'idle' }; delete view.error; delete view.probe; options.changed()
        worker = (async () => {
          const value = readCurrent(); const existing = value.providers[command.slot]
          const old = existing && 'base_url' in existing ? existing : undefined
          const baseUrl = command.baseUrl.trim() || old?.base_url || ''
          const model = command.model.trim() || old?.model || ''
          const apiKey = command.apiKey?.trim() || old?.api_key || ''
          if (!baseUrl || !model || !apiKey) throw new Error('MODEL_CONFIGURATION_INVALID')
          const url = new URL(baseUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('MODEL_CONFIGURATION_INVALID')
          value.routing = inferModelRouting(value)
          value.providers[command.slot] = { base_url: baseUrl, api_key: apiKey, model }
          if (command.slot === 'privacy' || command.slot === 'background' || command.slot === 'work') value.routing[command.slot] = 'independent'
          // Thinking levels belong to a model: another model starts from its provider's default.
          const role = roleOf(command.slot)
          if (role && old?.model !== model && value.efforts) delete value.efforts[role]
          if (command.slot === 'chat' && old?.model !== model && value.routing.work === 'follow-main' && value.efforts) delete value.efforts.work
          writeCurrent(value); await refreshSlots()
          view = { ...view, status: 'saved', restartRequired: options.apply ? view.restartRequired : true }
        })().catch(() => fail('configuration-failed')).finally(() => { worker = undefined; options.changed() })
        return
      }
      if (command.type === 'models.provider.remove') {
        if (!MODEL_SLOTS.has(command.slot)) return 'invalid-command'
        view = { ...view, status: 'idle' }; delete view.error; delete view.probe; options.changed()
        worker = (async () => {
          const value = readCurrent(); value.routing = inferModelRouting(value); delete value.providers[command.slot]
          writeCurrent(value); await refreshSlots()
          view = { ...view, status: 'saved', restartRequired: options.apply ? view.restartRequired : true }
        })().catch(() => fail('configuration-failed')).finally(() => { worker = undefined; options.changed() })
        return
      }
      if (command.type === 'models.routing.set') {
        view = { ...view, status: 'idle' }; delete view.error; delete view.probe; options.changed()
        worker = (async () => {
          const value = readCurrent(); value.routing = { ...inferModelRouting(value), [command.slot]: command.mode }
          writeCurrent(value); await refreshSlots()
          view = { ...view, status: 'saved', restartRequired: options.apply ? view.restartRequired : true }
        })().catch(() => fail('configuration-failed')).finally(() => { worker = undefined; options.changed() })
        return
      }
      if (command.type === 'models.effort.set') {
        view = { ...view, status: 'idle' }; delete view.error; delete view.probe; options.changed()
        worker = (async () => {
          const value = readCurrent(); const efforts: ModelEfforts = { ...value.efforts }
          if (command.effort) efforts[command.role] = command.effort; else delete efforts[command.role]
          value.efforts = efforts
          writeCurrent(value)
          view = { ...view, status: 'saved', efforts: { ...efforts } }
          options.effortsChanged?.(efforts)
        })().catch(() => fail('configuration-failed')).finally(() => { worker = undefined; options.changed() })
        return
      }
      if (command.type === 'models.service.save') {
        view = { ...view, status: 'idle' }; delete view.error; delete view.probe; options.changed()
        worker = (async () => {
          const value = readCurrent(); const existing = value.providers[command.service]
          const old = existing && 'base_url' in existing ? existing : undefined
          const baseUrl = command.baseUrl.trim() || old?.base_url || ''
          const model = command.model.trim() || old?.model || ''
          const apiKey = command.apiKey?.trim() || old?.api_key || ''
          const voice = command.voice?.trim() || (existing && 'voice' in existing ? existing.voice : '') || ''
          const url = new URL(baseUrl)
          if (!baseUrl || command.service === 'tts' && !model || !apiKey || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('MODEL_CONFIGURATION_INVALID')
          if (command.service === 'tts') {
            if (!voice) throw new Error('MODEL_CONFIGURATION_INVALID')
            value.providers.tts = { protocol: 'openai-speech', base_url: baseUrl, api_key: apiKey, model, voice }
          } else value.providers.rodin = { base_url: baseUrl, api_key: apiKey, model }
          writeCurrent(value); await refreshSlots()
          view = { ...view, status: 'saved', restartRequired: true }
        })().catch(() => fail('configuration-failed')).finally(() => { worker = undefined; options.changed() })
        return
      }
      if (command.type === 'mail.configure') {
        view = { ...view, status: 'idle' }; delete view.error; delete view.probe; options.changed()
        worker = (async () => {
          const value = readCurrent(); const old = value.mail
          const host = command.host.trim() || old?.host || ''
          const user = command.user.trim() || old?.user || ''
          const authCode = command.authCode?.trim() || old?.auth_code || ''
          const port = command.port || old?.port || 993
          if (!host || !user || !authCode) throw new Error('MODEL_CONFIGURATION_INVALID')
          value.mail = { host, port, tls: true, user, auth_code: authCode, folder: '桃子' }
          writeCurrent(value); await refreshSlots()
          view = { ...view, status: 'saved', restartRequired: true }
        })().catch(() => fail('configuration-failed')).finally(() => { worker = undefined; options.changed() })
        return
      }
      if (command.type === 'models.probe') {
        if (!MODEL_SLOTS.has(command.slot)) return 'invalid-command'
        view = { ...view, probe: { slot: command.slot, status: 'testing', atMs: options.clock.nowMs() } }; delete view.error; options.changed()
        worker = (async () => {
          let code: PublicErrorCode | undefined
          try {
            const value = readCurrent(); const routing = inferModelRouting(value); const effective = (command.slot === 'privacy' || command.slot === 'background' || command.slot === 'work') && routing[command.slot] === 'follow-main' ? 'chat' : command.slot; const config = value.providers[effective]
            if (!config || !('base_url' in config) || !config.base_url || !config.api_key || !config.model) throw new ModelFailure('configuration')
            // 固定小请求也走资源账本：按保守的 2000 单位预留，失败同样计入尝试。
            options.budget?.reserveModel(2_000, 'work')
            const providers = new Map([[command.slot, { base_url: config.base_url, api_key: config.api_key, model: config.model }]])
            const abort = new AbortController(); const stop = options.clock.after(20_000, () => abort.abort())
            try {
              await createModelClient(providers, [command.slot], options.clock).complete({ messages: [{ role: 'user', content: 'Reply with OK only.' }], tools: [], signal: abort.signal, toolsExecuted: false, maxOutputTokens: 16 }, () => {})
            } finally { stop() }
          } catch (error) { code = error instanceof ModelFailure ? probeCode(error.kind) : error instanceof ResourceFailure ? error.code : 'configuration-failed' }
          view = { ...view, probe: { slot: command.slot, status: code ? 'failed' : 'ok', ...(code ? { code } : {}), atMs: options.clock.nowMs() } }
        })().catch(() => { view = { ...view, probe: { slot: command.slot, status: 'failed', code: 'configuration-failed', atMs: options.clock.nowMs() } } }).finally(() => { worker = undefined; options.changed() })
        return
      }
      if (command.type !== 'models.configure') return 'invalid-command'
      view = { ...view, status: 'selecting' }; delete view.error; delete view.probe; options.changed()
      worker = (async () => {
        const file = await options.choose(); if (!file || disposed) { view.status = 'idle'; return }
        const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256_000) throw new Error('MODEL_CONFIGURATION_INVALID')
        const value = parseConfig(readFileSync(file, 'utf8'))
        for (const config of Object.values(value.providers)) if (config.base_url) { const url = new URL(config.base_url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('MODEL_CONFIGURATION_INVALID') }
        writeCurrent(value); await refreshSlots()
        view = { ...view, status: 'saved', restartRequired: true }
      })().catch(() => fail('configuration-failed')).finally(() => { worker = undefined; options.changed() })
    },
    idle: async () => { await worker }, close: async () => { disposed = true; await worker },
  }
}
export type ModelSettingsService = ReturnType<typeof createModelSettings>

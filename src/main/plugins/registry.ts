import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { PluginView, PublicErrorCode } from '../../shared'
import type { CandidateSeed, HarnessTool, ToolResult } from '../harness/tools'
import type { SettingsStore } from '../config/settings'
import { createPrivacyFilter, type PrivacyModel } from '../privacy/filter'
import { systemClock, type Clock } from '../clock'
import { manifestSchema, type PluginManifest } from './manifest'
import type { SourceMail } from '../mail/types'

interface Entry { view: PluginView; manifest?: PluginManifest; folder?: string; code?: string; tools: HarnessTool[]; handlesPrivacy?: boolean; calls?: Set<AbortController>; activate?: (context: PluginActivationContext) => unknown }
export interface PluginActivationContext {
  nowMs(): number
  signal: AbortSignal
  /** Narrow user-only sink; candidate excerpts never enter the model context or tool journal. */
  ingestCandidates(seeds: readonly CandidateSeed[]): void
}
const resultSchema = z.strictObject({ ok: z.boolean(), raw: z.json(), visible: z.json(),
  sourceMails: z.array(z.strictObject({ uidValidity: z.string().regex(/^\d{1,20}$/), uid: z.number().int().positive(), senderAddress: z.string().max(320), senderName: z.string().max(256),
    subject: z.string().max(256), body: z.string().min(1).max(64_000), sentAtMs: z.number().int().nonnegative(), receivedAtMs: z.number().int().nonnegative() })).max(20).optional(),
  imageRefs: z.array(z.string().regex(/^work-frame:[a-f0-9]{64}$/)).max(1).optional(),
  original: z.string().max(64_000).optional(),
  fields: z.record(z.string().max(40), z.union([z.string().max(100), z.number().finite(), z.boolean()])).optional(),
  candidates: z.array(z.strictObject({ externalId: z.string().min(1).max(128), title: z.string().min(1).max(1000), kind: z.enum(['deadline', 'event']),
    deadlineIso: z.string().max(64).nullable(), eventStartIso: z.string().max(64).optional(), eventEndIso: z.string().max(64).optional(),
    locationText: z.string().max(1000).optional(), sourceLabel: z.string().min(1).max(1000), sourceAtMs: z.number().int().nonnegative().optional(),
    excerpt: z.string().min(1).max(64_000) })).max(32).optional() })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function contained(root: string, file: string) {
  const path = realpathSync(resolve(root, file)); const rel = relative(realpathSync(root), path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('PLUGIN_PATH_INVALID')
  return path
}
function bounded(path: string, limit: number) {
  if (statSync(path).size > limit) throw new Error('PLUGIN_FILE_TOO_LARGE')
  return readFileSync(path, 'utf8')
}
function validateParameters(parameters: Record<string, unknown>) {
  const encoded = JSON.stringify(parameters)
  // Version one intentionally excludes references, executable formats, and remote resolution.
  if (parameters.type !== 'object' || encoded.length > 32_000 || /"\$(ref|id|schema)"/.test(encoded)) throw new Error('PLUGIN_SCHEMA_INVALID')
  return z.fromJSONSchema(parameters)
}

export function createPluginRegistry(options: { root: string; settings: SettingsStore; clock?: Clock; privacyModel?: PrivacyModel | null; privacyEnabled?(): boolean; fileFiltering?: () => boolean;
  onSources?(sources: readonly SourceMail[], signal: AbortSignal): Promise<{ ok: boolean; candidateCount?: number; error?: PublicErrorCode }>;
  onCandidates?: (seeds: readonly CandidateSeed[], source: { pluginId: string; tool?: string }) => void }) {
  const clock = options.clock ?? systemClock
  const entries = new Map<string, Entry>()
  const services = new Map<string, (enabled: boolean) => void>()
  const filter = (text: string, signal?: AbortSignal) => createPrivacyFilter(options.privacyModel ?? null)(text, signal)
  const takeCandidates = (entry: Entry, result: ToolResult, tool?: string): ToolResult => {
    if (!result.candidates?.length) return result
    if (result.ok) {
      try { options.onCandidates?.(result.candidates, { pluginId: entry.view.id, ...(tool ? { tool } : {}) }) } catch { /* Candidate storage failure is reported by the host sink. */ }
    }
    const observable = { ...result }
    delete observable.candidates
    return observable
  }
  const wrap = (entry: Entry, tool: HarnessTool): HarnessTool => ({ ...tool, run: async (input, context): Promise<ToolResult> => {
    if (entry.view.status !== 'enabled') return { ok: false, raw: { error: 'plugin-disabled' }, visible: { error: 'plugin-disabled' } }
    // Fail before invoking even a read operation if its mandatory privacy dependency is absent.
    const filtering = options.privacyEnabled?.() !== false && (entry.view.privacy === 'always' || (entry.view.privacy === 'optional' && options.fileFiltering?.()))
    if (filtering && !entry.handlesPrivacy && !options.privacyModel) return { ok: false, raw: { error: 'privacy-unavailable' }, visible: { error: 'privacy-unavailable' } }
    const call = new AbortController(); (entry.calls ??= new Set()).add(call)
    const signal = AbortSignal.any([context.signal, call.signal])
    try {
    const result = resultSchema.parse(await tool.run(input, { ...context, signal }))
    signal.throwIfAborted()
    const currentFiltering = options.privacyEnabled?.() !== false && (entry.view.privacy === 'always' || (entry.view.privacy === 'optional' && options.fileFiltering?.()))
    if (currentFiltering !== filtering) return { ok: false, raw: { error: 'permission-changed' }, visible: { error: 'permission-changed' } }
    if (JSON.stringify(result).length > 1_000_000) throw new Error('PLUGIN_RESULT_TOO_LARGE')
    if (result.sourceMails) {
      // Raw school evidence uses the host's existing extraction/validation pipeline, never a tool journal.
      const processed = result.ok && options.onSources ? await options.onSources(result.sourceMails, signal) : { ok: false, error: 'unavailable' as const }
      signal.throwIfAborted()
      delete result.sourceMails
      const receipt = { source: entry.view.id, processed: processed.ok, candidateCount: processed.candidateCount ?? 0, ...(processed.error ? { error: processed.error } : {}) }
      return takeCandidates(entry, { ok: processed.ok, raw: receipt, visible: receipt, candidates: result.candidates }, tool.definition.name)
    }
    if (!filtering || entry.handlesPrivacy) return takeCandidates(entry, result, tool.definition.name)
    const filtered = await filter(JSON.stringify(result.raw), signal)
    signal.throwIfAborted()
    return filtered.ok ? { ok: result.ok, raw: filtered.fields, visible: { ...filtered.fields, trust: filtered.trust }, fields: {} }
      : { ok: false, raw: { error: filtered.error }, visible: { error: filtered.error }, fields: {} }
    } finally { entry.calls.delete(call) }
  } })
  const registerBuiltin = (id: string, name: string, tools: HarnessTool[], policy?: { handlesPrivacy: true; permissions: PluginView['permissions'] }) => {
    if (entries.has(id)) throw new Error('DUPLICATE_PLUGIN')
    const names = new Set([...entries.values()].flatMap((entry) => entry.view.tools))
    if (tools.some((tool) => names.has(tool.definition.name))) throw new Error('DUPLICATE_TOOL')
    const fingerprint = hash(JSON.stringify(tools.map((tool) => tool.definition)))
    const saved = options.settings.read().plugins[id]
    const entry: Entry = { view: { id, name, version: '1.0.0', source: 'builtin', status: saved?.enabled === false ? 'disabled' : 'enabled',
      privacy: policy ? 'always' : saved?.privacy ?? 'none', permissions: policy?.permissions ?? [], ...(policy ? { privacyLocked: true } : {}), tools: tools.map((tool) => tool.definition.name), fingerprint }, tools: [], handlesPrivacy: policy?.handlesPrivacy }
    entry.tools = tools.map((tool) => wrap(entry, tool)); entries.set(id, entry)
  }
  const discover = () => {
    if (!existsSync(options.root)) return
    for (const folder of readdirSync(options.root, { withFileTypes: true }).slice(0, 100)) {
      if (!folder.isDirectory() || folder.isSymbolicLink()) continue
      try {
        const root = contained(options.root, folder.name)
        const manifestText = bounded(contained(root, 'manifest.json'), 64_000)
        const manifest = manifestSchema.parse(JSON.parse(manifestText))
        if (entries.has(manifest.id)) continue
        const code = manifest.entry ? bounded(contained(root, manifest.entry), 512_000) : ''
        for (const asset of manifest.furniture) contained(root, asset.image)
        const fingerprint = hash(manifestText + '\n' + code)
        const saved = options.settings.read().plugins[manifest.id]
        const conflict = manifest.tools.some((tool) => [...entries.values()].some((entry) => entry.view.tools.includes(tool.name)))
        const status = manifest.apiVersion !== 1 || conflict ? 'incompatible' : !manifest.entry ? (saved?.enabled === false ? 'disabled' : 'enabled')
          : saved?.fingerprint !== fingerprint ? 'needs-approval' : 'disabled'
        const entry: Entry = { view: { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description, source: 'folder', status,
          privacy: saved?.privacy ?? manifest.privacy, permissions: manifest.permissions, tools: manifest.tools.map((tool) => tool.name), fingerprint },
          manifest, folder: root, code, tools: [] }
        entries.set(manifest.id, entry)
        if (status === 'disabled' && saved?.enabled) enable(manifest.id, fingerprint)
      } catch { /* Invalid/untrusted folders never execute code or expose their content in diagnostics. */ }
    }
  }
  const enable = (id: string, fingerprint: string): PublicErrorCode | undefined => {
    const entry = entries.get(id)
    if (!entry || fingerprint !== entry.view.fingerprint || ['incompatible', 'failed'].includes(entry.view.status)) return 'invalid-command'
    if (entry.view.status === 'enabled') return
    try {
      if (entry.manifest?.entry && entry.folder) {
        // Recheck disk before consent is used; a changed entry must be discovered and approved again.
        const manifestText = bounded(contained(entry.folder, 'manifest.json'), 64_000)
        const code = bounded(contained(entry.folder, entry.manifest.entry), 512_000)
        if (hash(manifestText + '\n' + code) !== fingerprint) { entry.view.status = 'needs-approval'; return 'permission-denied' }
        const validators = entry.manifest.tools.map((tool) => validateParameters(tool.parameters))
        const path = contained(entry.folder, entry.manifest.entry)
        const require = createRequire(path); delete require.cache[path]
        // Explicitly approved local Node code is trusted with its declared capabilities, not sandboxed.
        const exported: unknown = require(path)
        if (!exported || typeof exported !== 'object' || !('tools' in exported) || !exported.tools || typeof exported.tools !== 'object') throw new Error('PLUGIN_EXPORT_INVALID')
        const implementations = exported.tools as Record<string, unknown>
        entry.tools = entry.manifest.tools.map((tool, index) => {
          const fn = implementations[tool.name]
          if (typeof fn !== 'function') throw new Error('PLUGIN_EXPORT_INVALID')
          return wrap(entry, { definition: { name: tool.name, description: tool.description, parameters: tool.parameters }, templateId: tool.templateId,
            validate: (input) => validators[index].safeParse(input).success,
            // No store, credentials, or internal loop hooks are passed to external implementations.
            run: async (input, context) => fn(input, { nowMs: () => context.clock.nowMs(), signal: context.signal, turnId: context.turnId }) as Promise<ToolResult> })
        })
        const activate = 'activate' in exported ? exported.activate : undefined
        entry.activate = typeof activate === 'function' ? (activate as (context: PluginActivationContext) => unknown) : undefined
      }
      options.settings.update((draft) => { draft.plugins[id] = { enabled: true, fingerprint, privacy: entry.view.privacy } })
      entry.view.status = 'enabled'
      services.get(id)?.(true)
      if (entry.activate) {
        const activation = {
          nowMs: () => clock.nowMs(),
          signal: new AbortController().signal,
          ingestCandidates: (seeds: readonly CandidateSeed[]) => {
            if (entry.view.status !== 'enabled') return
            const filtering = options.privacyEnabled?.() !== false && (entry.view.privacy === 'always' || (entry.view.privacy === 'optional' && options.fileFiltering?.()))
            if (!filtering || entry.handlesPrivacy) options.onCandidates?.(seeds, { pluginId: entry.view.id })
          },
        }
        // Activation is best effort; a source outage must not make the plugin permanently failed.
        void Promise.resolve(entry.activate(activation)).catch(() => {})
      }
    } catch { entry.view.status = 'failed'; return 'internal' }
  }
  const install = (source: string): PublicErrorCode | undefined => {
    let target: string | undefined
    try {
      const sourceRoot = realpathSync(resolve(source))
      if (!statSync(sourceRoot).isDirectory()) return 'configuration-failed'
      const manifestText = bounded(contained(sourceRoot, 'manifest.json'), 64_000)
      const manifest = manifestSchema.parse(JSON.parse(manifestText))
      if (entries.has(manifest.id)) return 'invalid-command'
      target = join(options.root, manifest.id)
      if (existsSync(target)) return 'invalid-command'
      // Validate every referenced file before copying; copying never follows symlinks.
      if (manifest.entry) bounded(contained(sourceRoot, manifest.entry), 512_000)
      for (const asset of manifest.furniture) contained(sourceRoot, asset.image)
      mkdirSync(options.root, { recursive: true })
      let total = 0
      cpSync(sourceRoot, target, { recursive: true, dereference: false, errorOnExist: true, force: false,
        filter: (path) => {
          const stat = lstatSync(path); if (stat.isSymbolicLink()) return false
          if (stat.isFile()) { total += stat.size; if (stat.size > 5_000_000 || total > 20_000_000) return false }
          return true
        } })
      discover()
      if (!entries.has(manifest.id)) throw new Error('PLUGIN_INSTALL_FAILED')
      return
    } catch {
      if (target) { try { rmSync(target, { recursive: true, force: true }) } catch { /* best effort */ } }
      return 'configuration-failed'
    }
  }
  return { registerBuiltin, discover, enable, install,
    mountService: (id: string, changed: (enabled: boolean) => void) => {
      const entry = entries.get(id)
      if (!entry || entry.view.source !== 'builtin') throw new Error('SERVICE_PLUGIN_REQUIRED')
      services.set(id, changed); changed(entry.view.status === 'enabled')
      return () => { services.delete(id); changed(false) }
    },
    views: () => structuredClone([...entries.values()].map((entry) => entry.view)),
    tools: () => [...entries.values()].filter((entry) => entry.view.status === 'enabled').flatMap((entry) => entry.tools),
    disable: (id: string): PublicErrorCode | undefined => {
      const entry = entries.get(id); if (!entry) return 'invalid-command'
      options.settings.update((draft) => { draft.plugins[id] = { enabled: false, fingerprint: entry.view.fingerprint, privacy: entry.view.privacy } })
      entry.view.status = 'disabled'
      for (const call of entry.calls ?? []) call.abort()
      services.get(id)?.(false)
    },
    setPrivacy: (id: string, privacy: PluginView['privacy']): PublicErrorCode | undefined => {
      const entry = entries.get(id); if (!entry) return 'invalid-command'
      if (entry.view.privacyLocked && privacy !== 'always') return 'permission-denied'
      for (const call of entry.calls ?? []) call.abort()
      options.settings.update((draft) => { draft.plugins[id] = { enabled: entry.view.status === 'enabled', fingerprint: entry.view.fingerprint, privacy } })
      entry.view.privacy = privacy
    },
  }
}

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { PluginView, PublicErrorCode } from '../../shared'
import type { HarnessTool, ToolResult } from '../harness/tools'
import type { SettingsStore } from '../config/settings'
import { createPrivacyFilter, type PrivacyModel } from '../privacy/filter'
import { manifestSchema, type PluginManifest } from './manifest'

interface Entry { view: PluginView; manifest?: PluginManifest; folder?: string; code?: string; tools: HarnessTool[]; handlesPrivacy?: boolean }
const resultSchema = z.strictObject({ ok: z.boolean(), raw: z.json(), visible: z.json(),
  imageRefs: z.array(z.string().regex(/^work-frame:[a-f0-9]{64}$/)).max(1).optional(),
  fields: z.record(z.string().max(40), z.union([z.string().max(100), z.number().finite(), z.boolean()])).optional() })
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

export function createPluginRegistry(options: { root: string; settings: SettingsStore; privacyModel?: PrivacyModel | null; fileFiltering?: () => boolean }) {
  const entries = new Map<string, Entry>()
  const services = new Map<string, (enabled: boolean) => void>()
  const filter = createPrivacyFilter(options.privacyModel ?? null)
  const wrap = (entry: Entry, tool: HarnessTool): HarnessTool => ({ ...tool, run: async (input, context): Promise<ToolResult> => {
    if (entry.view.status !== 'enabled') return { ok: false, raw: { error: 'plugin-disabled' }, visible: { error: 'plugin-disabled' } }
    // Fail before invoking even a read operation if its mandatory privacy dependency is absent.
    const filtering = entry.view.privacy === 'always' || (entry.view.privacy === 'optional' && options.fileFiltering?.())
    if (filtering && !entry.handlesPrivacy && !options.privacyModel) return { ok: false, raw: { error: 'privacy-unavailable' }, visible: { error: 'privacy-unavailable' } }
    const result = resultSchema.parse(await tool.run(input, context))
    if (JSON.stringify(result).length > 1_000_000) throw new Error('PLUGIN_RESULT_TOO_LARGE')
    if (!filtering || entry.handlesPrivacy) return result
    const filtered = await filter(JSON.stringify(result.raw), context.signal)
    return filtered.ok ? { ok: result.ok, raw: result.raw, visible: { ...filtered.fields, trust: filtered.trust }, fields: {} }
      : { ok: false, raw: result.raw, visible: { error: filtered.error }, fields: {} }
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
        const entry: Entry = { view: { id: manifest.id, name: manifest.name, version: manifest.version, source: 'folder', status,
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
      }
      options.settings.update((draft) => { draft.plugins[id] = { enabled: true, fingerprint, privacy: entry.view.privacy } })
      entry.view.status = 'enabled'
      services.get(id)?.(true)
    } catch { entry.view.status = 'failed'; return 'internal' }
  }
  return { registerBuiltin, discover, enable,
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
      services.get(id)?.(false)
    },
    setPrivacy: (id: string, privacy: PluginView['privacy']): PublicErrorCode | undefined => {
      const entry = entries.get(id); if (!entry) return 'invalid-command'
      if (entry.view.privacyLocked && privacy !== 'always') return 'permission-denied'
      options.settings.update((draft) => { draft.plugins[id] = { enabled: entry.view.status === 'enabled', fingerprint: entry.view.fingerprint, privacy } })
      entry.view.privacy = privacy
    },
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const plugin = z.strictObject({ enabled: z.boolean(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), privacy: z.enum(['none', 'optional', 'always']).optional() })
const schema = z.strictObject({ version: z.literal(1), developer: z.boolean(), booth: z.boolean(),
  plugins: z.record(z.string(), plugin), sceneId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(), fileFilteringEnabled: z.boolean().default(false),
  activeCharacterId: z.string().regex(/^(?:default-character|character:[a-f0-9]{64})$/).optional(),
  miniPosition: z.strictObject({ x: z.number().int().min(-100000).max(100000), y: z.number().int().min(-100000).max(100000), displayId: z.number().int().optional() }).optional(),
  // Resolved once so a later naming change cannot silently move an existing room; absence means version 1.
  roomLayout: z.strictObject({ pathVersion: z.literal(2), root: z.string().min(3), folder: z.string().min(1).optional() }).optional() })
export type Settings = z.infer<typeof schema>

/** Configuration contains consent and preferences only. Provider credentials have another owner. */
export function openSettings(root: string) {
  mkdirSync(root, { recursive: true })
  const path = join(root, 'settings.json')
  let value: Settings = { version: 1, developer: false, booth: false, plugins: {}, fileFilteringEnabled: false }
  if (existsSync(path)) {
    try { value = schema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
    catch { throw new Error('SETTINGS_INVALID') }
  }
  return {
    read: () => structuredClone(value),
    update: (mutate: (draft: Settings) => void) => {
      const draft = structuredClone(value); mutate(draft)
      const next = schema.parse(draft)
      writeFileSync(path + '.tmp', JSON.stringify(next), { mode: 0o600 })
      renameSync(path + '.tmp', path)
      value = next
    },
  }
}
export type SettingsStore = ReturnType<typeof openSettings>

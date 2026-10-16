import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const mailSchema = z.object({
  host: z.string().min(1), port: z.number().int().min(1).max(65535), tls: z.literal(true),
  user: z.string().min(1), auth_code: z.string().min(1), folder: z.literal('桃子'),
})
export type MailCredentials = z.infer<typeof mailSchema>

/** Main-only bootstrap. No serialized return path to renderer, logs, or debug tools. */
export async function readMailCredentials(filename: string): Promise<MailCredentials> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filename, 'utf8'))
    return z.object({ mail: mailSchema }).parse(parsed).mail
  } catch {
    throw new Error('MAIL_CONFIG_UNAVAILABLE')
  }
}

export const PROVIDER_SLOTS = ['chat', 'background', 'chat_google', 'chat_claude', 'privacy'] as const
export type ProviderSlot = typeof PROVIDER_SLOTS[number]
/** Backup exclusion guard. Never serialize these values or expose them through errors/debugging. */
export async function readPrivateCredentialValues(filename: string): Promise<readonly string[]> {
  try {
    const parsed = z.object({ providers: z.record(z.string(), z.unknown()).optional(), mail: z.unknown().optional() }).parse(JSON.parse(await readFile(filename, 'utf8')))
    const keys = Object.values(parsed.providers ?? {}).flatMap((entry) => { const provider = z.object({ api_key: z.string() }).safeParse(entry); return provider.success && provider.data.api_key ? [provider.data.api_key] : [] })
    const mail = z.object({ auth_code: z.string() }).safeParse(parsed.mail)
    return [...keys, ...(mail.success && mail.data.auth_code ? [mail.data.auth_code] : [])]
  } catch { return [] }
}
export interface ProviderConfig { base_url: string; api_key: string; model: string }

/** Called only by main. Empty/malformed slots remain unavailable; values never leave this boundary. */
export async function readModelProviders(filename: string): Promise<ReadonlyMap<ProviderSlot, ProviderConfig>> {
  try {
    const parsed = z.object({ providers: z.record(z.string(), z.unknown()) }).parse(JSON.parse(await readFile(filename, 'utf8')))
    const result = new Map<ProviderSlot, ProviderConfig>()
    const schema = z.object({ base_url: z.string().url(), api_key: z.string().min(1), model: z.string().min(1) })
    for (const slot of PROVIDER_SLOTS) {
      const entry = schema.safeParse(parsed.providers[slot])
      if (!entry.success) continue
      const url = new URL(entry.data.base_url)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) continue
      result.set(slot, Object.freeze(entry.data))
    }
    return result
  } catch { return new Map() }
}

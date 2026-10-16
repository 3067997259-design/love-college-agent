import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OpticalTier } from '../../shared'
import type { OpticalPort } from './schema'
export const opticalConfigSchema = z.strictObject({ endpoint: z.string().url().max(4096), apiKey: z.string().max(8192).default('') }).superRefine((value, ctx) => {
  const url = new URL(value.endpoint); const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ctx.addIssue({ code: 'custom', message: 'Invalid optical configuration' })
})
export type OpticalConfig = z.infer<typeof opticalConfigSchema>
export function readOpticalConfig(file: string, developer = false): OpticalConfig {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16000) throw new Error('OPTICAL_CONFIGURATION_INVALID')
  const value = opticalConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  if (developer && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value.endpoint).hostname)) throw new Error('OPTICAL_DEVELOPER_REMOTE_REFUSED')
  return value
}
export function saveOpticalConfig(root: string, value: OpticalConfig) {
  const folder = join(root, 'connections'); mkdirSync(folder, { recursive: true })
  if (lstatSync(folder).isSymbolicLink() || realpathSync(folder) !== resolve(folder)) throw new Error('OPTICAL_CONFIGURATION_INVALID')
  const file = join(folder, 'optical.json')
  if (existsSync(file)) { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('OPTICAL_CONFIGURATION_INVALID') }
  const temporary = join(folder, 'optical-' + randomUUID() + '.tmp'); writeFileSync(temporary, JSON.stringify(opticalConfigSchema.parse(value)), { flag: 'wx', mode: 0o600 }); renameSync(temporary, file)
}
const sizes: Record<OpticalTier, number> = { large: 1280, base: 1024, small: 640, tiny: 512 }
/** Our explicit decoder adapter contract. No source text, URLs from model output, redirects or retries. */
export function createOpticalHttpPort(config: OpticalConfig, source: 'real' | 'fake' = 'real', fetcher: typeof fetch = fetch): OpticalPort {
  const fixed = opticalConfigSchema.parse(config)
  return { source, decode: async (png, tier, signal) => {
    signal.throwIfAborted()
    const response = await fetcher(fixed.endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(fixed.apiKey ? { Authorization: 'Bearer ' + fixed.apiKey } : {}) }, signal,
      body: JSON.stringify({ image_base64: png.toString('base64'), mime: 'image/png', base_size: sizes[tier], image_size: sizes[tier], crop_mode: false, prompt: '<image>\nFree OCR.' }) })
    if (!response.ok) { await response.body?.cancel(); throw new Error('OPTICAL_DECODE_FAILED') }
    const reader = response.body?.getReader(); if (!reader) throw new Error('OPTICAL_DECODE_FAILED')
    const chunks: Uint8Array[] = []; let length = 0
    try {
      while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 256000) throw new Error('OPTICAL_RESPONSE_TOO_LARGE'); chunks.push(next.value) }
      signal.throwIfAborted(); const bytes = Buffer.concat(chunks); const json = bytes.toString('utf8')
      if (!Buffer.from(json).equals(bytes)) throw new Error('OPTICAL_DECODE_INVALID')
      const text = z.strictObject({ text: z.string().max(64000) }).parse(JSON.parse(json)).text
      if (text.includes('\0') || Buffer.from(text).toString('utf8') !== text) throw new Error('OPTICAL_DECODE_INVALID')
      return text
    } finally { await reader.cancel().catch(() => {}) }
  } }
}

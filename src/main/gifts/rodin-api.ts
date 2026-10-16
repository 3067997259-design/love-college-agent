import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Clock } from '../clock'
import type { GiftMotif, GiftObjectId } from '../../shared'
import descriptions from './descriptions.json'
import { validateGlb } from '../storage/assets'

export interface RodinConfig { base_url: string; api_key: string }
export async function readRodinConfig(path: string): Promise<RodinConfig | null> {
  try { const parsed = z.object({ providers: z.object({ rodin: z.object({ base_url: z.string().url(), api_key: z.string().min(1) }) }) }).parse(JSON.parse(await readFile(path, 'utf8')))
    const url = new URL(parsed.providers.rodin.base_url); if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:')) return null
    return parsed.providers.rodin
  } catch { return null }
}
export interface RodinHandle { uuid: string; subscription_key: string }
export function createRodinApi(config: RodinConfig, clock: Clock) {
  const base = new URL(config.base_url); const prefix = base.pathname.replace(/\/(?:rodin|status|download)\/?$/, '').replace(/\/$/, '')
  const endpoint = (name: string) => new URL((prefix.includes('/api/v2') ? prefix : prefix + '/api/v2') + '/' + name, base.origin).toString()
  const request = async (name: string, body: BodyInit, signal: AbortSignal, json = false): Promise<unknown> => {
    const local = new AbortController(); const stop = clock.after(30_000, () => local.abort()); const combined = AbortSignal.any([signal, local.signal])
    try { const response = await fetch(endpoint(name), { method: 'POST', headers: { Authorization: 'Bearer ' + config.api_key, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body, signal: combined, redirect: 'error' })
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_000_000) throw new Error('RODIN_REQUEST_FAILED')
      if (!response.body) throw new Error('RODIN_REQUEST_FAILED')
      const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 1_000_000) throw new Error('RODIN_REQUEST_FAILED'); chunks.push(Buffer.from(chunk.value)) } } finally { await reader.cancel() }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (value && typeof value === 'object' && 'error' in value && value.error) throw new Error('RODIN_REQUEST_FAILED'); return value
    } catch { throw new Error('RODIN_REQUEST_FAILED') } finally { stop() }
  }
  return {
    submit: async (objectId: GiftObjectId, motif: GiftMotif, signal: AbortSignal): Promise<RodinHandle> => {
      const body = new FormData(); for (const [key, value] of Object.entries({ prompt: [descriptions.objects[objectId], descriptions.motifs[motif], descriptions.style].join(', '), tier: 'Gen-2.5-Low', mesh_mode: 'Raw', geometry_file_format: 'glb', quality_override: '18000', material: 'PBR' })) body.set(key, value)
      const parsed = z.object({ uuid: z.string().uuid(), jobs: z.object({ subscription_key: z.string().min(1).max(500) }) }).parse(await request('rodin', body, signal)); return { uuid: parsed.uuid, subscription_key: parsed.jobs.subscription_key }
    },
    poll: async (handle: RodinHandle, signal: AbortSignal): Promise<'waiting' | 'ready' | 'failed'> => {
      const parsed = z.object({ jobs: z.array(z.object({ status: z.enum(['Waiting', 'Generating', 'Done', 'Failed']) })).min(1).max(30) }).parse(await request('status', JSON.stringify({ subscription_key: handle.subscription_key }), signal, true))
      return parsed.jobs.some((job) => job.status === 'Failed') ? 'failed' : parsed.jobs.every((job) => job.status === 'Done') ? 'ready' : 'waiting'
    },
    download: async (handle: RodinHandle, signal: AbortSignal): Promise<Buffer> => {
      const parsed = z.object({ list: z.array(z.object({ name: z.string(), url: z.string().url() })).max(30) }).parse(await request('download', JSON.stringify({ task_uuid: handle.uuid }), signal, true))
      const item = parsed.list.find((item) => item.name.toLowerCase().endsWith('.glb')); if (!item) throw new Error('RODIN_RESULT_MISSING')
      const url = new URL(item.url); const localFixture = url.origin === base.origin && ['127.0.0.1', 'localhost'].includes(url.hostname)
      if (url.username || url.password || url.hash || !localFixture && (url.protocol !== 'https:' || !/(?:^|\.)(?:hyper3d\.(?:com|ai)|amazonaws\.com|aliyuncs\.com|cloudfront\.net|googleapis\.com)$/.test(url.hostname))) throw new Error('RODIN_DOWNLOAD_REFUSED')
      const local = new AbortController(); const stop = clock.after(60_000, () => local.abort())
      try { const response = await fetch(url, { signal: AbortSignal.any([signal, local.signal]), redirect: 'error' }); if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 32 * 1024 * 1024 || !response.body) throw new Error('RODIN_DOWNLOAD_FAILED')
        const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 32 * 1024 * 1024) throw new Error('RODIN_DOWNLOAD_FAILED'); chunks.push(Buffer.from(chunk.value)) } } finally { await reader.cancel() }
        const bytes = Buffer.concat(chunks); validateGlb(bytes); return bytes
      } catch { throw new Error('RODIN_DOWNLOAD_FAILED') } finally { stop() }
    },
  }
}
export type RodinApi = ReturnType<typeof createRodinApi>

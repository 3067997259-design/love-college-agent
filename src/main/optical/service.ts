import { join } from 'node:path'
import { z } from 'zod'
import type { AppCommand, OpticalMemoryRead, OpticalMemoryView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { BinaryAssets } from '../storage/assets'
import { assetUrl } from '../storage/assets'
import { calendarDay } from '../life/service'
import type { HarnessTool, ToolResult } from '../harness/tools'
import { createOpticalHttpPort, readOpticalConfig, saveOpticalConfig } from './client'
import { opticalDigest, opticalTier, type OpticalPort } from './schema'
import { opticalPages, guardOptical } from './sources'
import { opticalRecords } from './records'
import policy from './policy.json'

export function createOpticalMemory(options: {
  root: string; store: SessionStore; clock: Clock; assets: BinaryAssets; developer: boolean
  render(text: string, signal: AbortSignal): Promise<Buffer>; choose(): Promise<string | null>; available(): boolean; changed(): void; protectCredential(value: string): void
  port?: OpticalPort
}) {
  const { store, clock, assets } = options; const rows = () => store.history?.() ?? store.records()
  const enabled = rows().findLast((row) => row.type === 'optical/enabled')
  let optedIn = enabled?.type === 'optical/enabled' && enabled.enabled
  let pluginEnabled = true; let disposed = false; let broken = false; let failed = false; let worker: Promise<void> | undefined; let active: AbortController | undefined
  let port = options.port ?? null
  try { const config = readOpticalConfig(join(options.root, 'connections/optical.json'), options.developer); options.protectCredential(config.apiKey); port = createOpticalHttpPort(config, options.developer ? 'fake' : 'real') } catch { /* Optional unconfigured decoder does not break text memory. */ }
  const frames = () => rows().flatMap((row) => row.type === 'optical/frame' ? [row.frame] : [])
  const impressions = () => rows().flatMap((row) => row.type === 'optical/impression' ? [row.impression] : [])
  const validatePng = (png: Buffer) => { if (png.length < 33 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== 1280 || png.readUInt32BE(20) !== 1280) throw new Error('OPTICAL_IMAGE_INVALID') }
  try { opticalRecords(store); for (const frame of frames()) validatePng(assets.read(frame.asset)) } catch { broken = true }
  const allowed = () => optedIn && pluginEnabled && !disposed && !broken
  const gate = () => allowed() && !store.projection().lightsOut && options.available()
  const attempts = (operation: 'encode' | 'decode') => rows().filter((row) => row.type === 'optical/attempt' && row.operation === operation && calendarDay(clock, row.atMs) === calendarDay(clock)).length
  const launch = (operation: (signal: AbortSignal) => Promise<void>, timeoutMs = 30000) => {
    const abort = new AbortController(); active = abort; failed = false
    worker = Promise.resolve().then(async () => {
      let remove = () => {}; const stop = timeoutMs ? clock.after(timeoutMs, () => abort.abort()) : () => {}
      try {
        await Promise.race([operation(abort.signal), new Promise<never>((_resolve, reject) => { const cancel = () => reject(new Error('OPTICAL_STOPPED')); abort.signal.addEventListener('abort', cancel, { once: true }); remove = () => abort.signal.removeEventListener('abort', cancel); if (abort.signal.aborted) cancel() })])
      } catch { failed = !abort.signal.aborted }
      finally { stop(); remove(); abort.abort(); active = undefined; worker = undefined; options.changed() }
    }); options.changed()
  }
  const assertCurrent = (signal: AbortSignal) => { signal.throwIfAborted(); if (!gate()) throw new Error('OPTICAL_UNAVAILABLE') }
  const userRead = (id: string): OpticalMemoryRead => {
    opticalDigest.parse(id); if (broken) throw new Error('OPTICAL_UNAVAILABLE')
    const frame = frames().find((frame) => frame.id === id); if (!frame) throw new Error('OPTICAL_UNAVAILABLE')
    assets.read(frame.asset); opticalRecords(store)
    return { frameId: id, imageUrl: assetUrl(frame.asset), uncertainty: 'unreviewed-impression', impressions: impressions().filter((entry) => entry.frameId === id).map((entry) => ({ tier: entry.tier, status: entry.fragments.length ? 'guarded' : 'rejected', fragments: entry.fragments.map((fragment) => fragment.text), rejectedLineCount: entry.rejectedLineCount })) }
  }
  const toolInput = z.strictObject({ frameId: opticalDigest, tier: opticalTier.optional() })
  return {
    view: (): OpticalMemoryView => ({ enabled: allowed(), source: port?.source ?? 'none', status: broken || failed ? 'failed' : worker ? 'processing' : port ? 'idle' : 'unconfigured',
      frames: frames().map(({ id, sessionId, createdAtMs, sources, pageIndex, pageCount }) => ({ id, sessionId, createdAtMs, sourceCount: new Set(sources.map((source) => source.messageId)).size, pageIndex, pageCount })),
      impressions: impressions().map(({ frameId, tier, createdAtMs, fragments, rejectedLineCount }) => ({ frameId, tier, createdAtMs, status: fragments.length ? 'guarded' : 'rejected', verifiedLineCount: fragments.length, rejectedLineCount })), ...(broken || failed ? { error: { code: 'unavailable', retryable: !broken } } : {}) }),
    read: userRead,
    enabled: allowed,
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (disposed) return 'unavailable'
      if (command.type === 'optical.enable') {
        optedIn = command.enabled; if (!optedIn) active?.abort(); store.append({ type: 'optical/enabled', enabled: optedIn }); options.changed(); return
      }
      if (disposed || worker || !options.available()) return 'unavailable'
      if (command.type === 'optical.configure') {
        launch(async (signal) => {
          const file = await options.choose(); signal.throwIfAborted(); if (!file) return
          const config = readOpticalConfig(file, options.developer); options.protectCredential(config.apiKey); saveOpticalConfig(options.root, config)
          port = createOpticalHttpPort(config, options.developer ? 'fake' : 'real'); optedIn = false; store.append({ type: 'optical/enabled', enabled: false })
        }, 0); return
      }
      if (!gate()) return 'unavailable'
      if (command.type === 'optical.encode') {
        let pages: ReturnType<typeof opticalPages>; try { pages = opticalPages(store, command.sessionId).filter((page) => !frames().some((frame) => frame.id === page.id)) } catch { return 'invalid-command' }
        if (!pages.length) return
        if (frames().length + Math.min(4, pages.length) > 256 || attempts('encode') + Math.min(4, pages.length) > 16) return 'budget-exceeded'
        launch(async (signal) => {
          for (const page of pages.slice(0, 4)) {
            assertCurrent(signal); store.append({ type: 'optical/attempt', operation: 'encode', targetId: page.id })
            const png = await options.render(page.text, signal); assertCurrent(signal); validatePng(png)
            const asset = assets.write(png, 'png'); store.append({ type: 'asset/stored', asset })
            store.append({ type: 'optical/frame', frame: { id: page.id, sessionId: page.sessionId, createdAtMs: clock.nowMs(), pageIndex: page.pageIndex, pageCount: page.pageCount, sources: page.sources, asset, width: 1280, height: 1280 } }); options.changed()
          }
        }); return
      }
      if (command.type === 'optical.decode') {
        const frame = frames().find((frame) => frame.id === command.frameId); if (!frame) return 'invalid-command'
        if (!port) return 'not-configured'
        if (impressions().some((entry) => entry.frameId === frame.id && entry.tier === command.tier)) return
        if (attempts('decode') >= 8) return 'budget-exceeded'
        const selected = port
        launch(async (signal) => {
          assertCurrent(signal); const png = assets.read(frame.asset); validatePng(png)
          store.append({ type: 'optical/attempt', operation: 'decode', targetId: frame.id, tier: command.tier })
          const decoded = await selected.decode(png, command.tier, signal); assertCurrent(signal)
          if (decoded.length > 64000 || decoded.includes('\0')) throw new Error('OPTICAL_DECODE_INVALID')
          const guarded = guardOptical(store, frame, decoded)
          store.append({ type: 'optical/impression', impression: { frameId: frame.id, tier: command.tier, source: selected.source, createdAtMs: clock.nowMs(), ...guarded } })
        }); return
      }
      return 'invalid-command'
    },
    tool: (): HarnessTool => ({ definition: { name: 'recall_optical', description: policy.tool, parameters: z.toJSONSchema(toolInput) }, templateId: 'memory.optical', validate: (input) => toolInput.safeParse(input).success,
      run: async (input, context) => {
        context.signal.throwIfAborted(); if (!allowed() || store.projection().lightsOut) throw new Error('OPTICAL_UNAVAILABLE')
        const parsed = toolInput.parse(input); const frame = frames().find((frame) => frame.id === parsed.frameId); if (!frame) throw new Error('OPTICAL_UNAVAILABLE')
        const candidates = impressions().filter((entry) => entry.frameId === parsed.frameId && (!parsed.tier || entry.tier === parsed.tier))
        const selected = candidates.at(-1); if (!selected) throw new Error('OPTICAL_UNAVAILABLE')
        // Re-prove on every read, including after archive restore; OCR never becomes a canonical memory.
        opticalRecords(store)
        const value: Record<string, ToolResult['raw']> = { frameId: frame.id, sessionId: frame.sessionId, tier: selected.tier, status: selected.fragments.length ? 'guarded' : 'unknown', fragments: selected.fragments, uncertainty: policy.uncertainty, memoryAuthority: 'none', source: selected.source }
        return { ok: true, raw: value, visible: value }
      } }),
    setPluginEnabled: (value: boolean) => { pluginEnabled = value; if (!value) active?.abort(); options.changed() },
    foreground: () => active?.abort(),
    idle: async () => { await worker },
    close: async () => { disposed = true; active?.abort(); await worker },
  }
}
export type OpticalMemoryService = ReturnType<typeof createOpticalMemory>

import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MessageView, ActivityView, TaskView } from '../../shared'
import type { Clock } from '../clock'
import type { ModelClient } from '../model/types'
import type { SessionStore } from '../store/session'
import { openSessionStore } from '../store/session'
import { createHarness } from '../harness/loop'
import type { HarnessTool } from '../harness/tools'
import type { ContextMessage } from '../journal/schema'
import { imageSize } from '../model/image-size'
import { MemoryFailure } from '../memory/model'
import { sessionDayKey } from '../journal/file'
import { redactFixed } from '../privacy/redact'
import type { MinecraftService } from './service'
import definitions from './tools.json'
import policy from './policy.json'
import playSkill from './play-with-user.md?raw'

/** Separate game journals/projection/harness: ordinary model input, memories and private saves never
 * read this root. Only attempt counters are mirrored into the main journal for the shared budget.
 */
export function createMinecraftChat(options: { root: string; clock: Clock; mainStore: SessionStore; model: ModelClient;
  game(): MinecraftService; enabled(): boolean; persona(): { name: string; persona: string }; credentials: readonly string[]; changed(): void;
  normalizePixels?(png: Buffer): { jpeg: Buffer; width: number; height: number } }) {
  let store: SessionStore | undefined; let harness: ReturnType<typeof createHarness> | undefined; let closing: Promise<void> | undefined
  let roundId: string | undefined; let eventCount = 0
  const frames = new Map<string, Buffer>()
  const clearFrames = () => { for (const bytes of frames.values()) bytes.fill(0); frames.clear() }
  const scrub = (value: string) => options.credentials.reduce((text, credential) => credential ? text.replaceAll(credential, '[redacted]') : text, redactFixed(value))
  const tools: HarnessTool[] = definitions.map((definition) => ({ definition, templateId: 'minecraft.' + definition.name,
    validate: (input) => z.fromJSONSchema(definition.parameters as Parameters<typeof z.fromJSONSchema>[0]).safeParse(input).success,
    run: async (input, context) => {
      if (definition.name === 'minecraft_screenshot') {
        if (!options.normalizePixels) throw new Error('GAME_SCREENSHOT_UNAVAILABLE')
        const observed = await options.game().capture(context.signal)
        try {
          context.signal.throwIfAborted()
          if (!roundId || roundId !== observed.roundId || options.game().view().status !== 'playing') throw new Error('GAME_SCREENSHOT_STALE')
          const pixels = options.normalizePixels(observed.png); const dimensions = imageSize(pixels.jpeg, 'jpeg')
          if (pixels.jpeg.length > 262144 || pixels.width !== dimensions.width || pixels.height !== dimensions.height || pixels.width > 800 || pixels.height > 600) throw new Error('GAME_SCREENSHOT_LIMIT')
          const ref = 'game-frame:' + createHash('sha256').update(roundId + randomUUID()).update(pixels.jpeg).digest('hex')
          frames.set(ref, pixels.jpeg)
          while (frames.size > 2) { const oldest = frames.keys().next().value!; frames.get(oldest)!.fill(0); frames.delete(oldest) }
          const value = { frameRef: ref, width: pixels.width, height: pixels.height, capturedAtMs: observed.capturedAtMs, sourceTick: observed.sourceTick, source: 'client-framebuffer', trust: 'untrusted-game-pixels' }
          return { ok: true, raw: value, visible: value, imageRefs: [ref] }
        } finally { observed.png.fill(0) }
      }
      const value = z.json().parse(await options.game().tool(definition.name, input, context.signal))
      const clean = (value: z.core.util.JSONType, key = ''): z.core.util.JSONType => typeof value === 'string'
        ? key === 'uuid' && z.string().uuid().safeParse(value).success ? options.credentials.reduce((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text, value) : scrub(value)
        : Array.isArray(value) ? value.map((item) => clean(item)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item, name)])) : value
      const safe = clean(value); return { ok: true, raw: safe, visible: safe }
    },
  }))
  const end = () => {
    if (closing) return closing
    const oldHarness = harness; const oldStore = store; harness = undefined; store = undefined; roundId = undefined; clearFrames()
    closing = (async () => { await oldHarness?.dispose(); oldStore?.close() })().finally(() => { closing = undefined; options.changed() }); return closing
  }
  return {
    ready: () => options.enabled() && !closing,
    resolveImage: (ref: string) => {
      const view = options.game().view(); const pixels = frames.get(ref)
      if (!/^game-frame:[a-f0-9]{64}$/.test(ref) || !pixels || !roundId || view.roundId !== roundId || view.status !== 'playing' || !view.scope?.allowScreenshots) throw new Error('GAME_IMAGE_UNAVAILABLE')
      return pixels
    },
    begin: (id: string) => {
      if (store || closing || !options.enabled()) throw new Error('GAME_CHAT_UNAVAILABLE')
      roundId = id; eventCount = 0; store = openSessionStore(join(options.root, id), { userId: options.mainStore.scope.userId, characterId: options.mainStore.scope.characterId }, options.clock)
      const current = store
      const model: ModelClient = { source: options.model.source, complete: async (request, onAttempt) => {
        const reservation = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools })) + request.messages.reduce((sum, message) => sum + (message.imageRefs?.length ?? 0) * 16384, 0) + (request.maxOutputTokens ?? 800) + 1024
        const reply = await options.model.complete(request, (attempt) => {
          if (attempt.status === 'started') {
            const rows = (options.mainStore.history?.() ?? options.mainStore.records()).filter((row) => row.type === 'model/attempt' && row.status === 'started' && sessionDayKey(options.clock, row.atMs) === sessionDayKey(options.clock))
            const used = rows.reduce((sum, row) => sum + (row.type === 'model/attempt' ? row.reservedTokens ?? 0 : 0), 0)
            const autonomous = rows.reduce((sum, row) => sum + (row.type === 'model/attempt' && row.bucket === 'autonomous' ? row.reservedTokens ?? 0 : 0), 0)
            if (used + reservation > 500_000 || autonomous + reservation > 100_000) throw new MemoryFailure('budget-exceeded')
          }
          options.mainStore.append({ type: 'model/attempt', turnId: 'minecraft:' + id, ...attempt, bucket: 'autonomous', ...(attempt.status === 'started' ? { reservedTokens: reservation } : {}) }); onAttempt(attempt)
        })
        return { ...reply, text: scrub(reply.text), toolCalls: reply.toolCalls.map((call) => ({ ...call, arguments: scrub(call.arguments) })) }
      } }
      harness = createHarness({ clock: options.clock, store: current, model, tools, getTools: () => {
        const view = options.game().view(); const feature = { minecraft_inventory: 'inventory', minecraft_scene: 'scene', minecraft_look: 'look', minecraft_screenshot: 'screenshot', minecraft_mine: 'mining' } as const
        return tools.filter((tool) => (tool.definition.name !== 'minecraft_chat' || view.scope?.allowChat)
          && (tool.definition.name !== 'minecraft_screenshot' || view.scope?.allowScreenshots && !!options.normalizePixels)
          && (tool.definition.name !== 'minecraft_mine' || view.scope?.allowMining)
          && (!(tool.definition.name in feature) || view.features?.includes(feature[tool.definition.name as keyof typeof feature])))
      }, limits: { steps: 8, dailyTokens: 80_000, autonomousTokens: 80_000, outputTokens: 800 },
        enabled: () => options.enabled() && options.game().view().status === 'playing', changed: options.changed,
        prepareContext: async (_id, signal) => {
          signal.throwIfAborted(); const view = options.game().view(); const persona = options.persona()
          const seenFrames = new Set<string>(); const context = current.projection().context.slice().reverse().map((message) => {
            if (!message.imageRefs) return message
            const imageRefs = message.imageRefs.filter((ref) => { if (!frames.has(ref) || seenFrames.has(ref)) return false; seenFrames.add(ref); return true })
            return { ...message, imageRefs }
          }).reverse()
          const messages: ContextMessage[] = [{ role: 'system', content: policy.system }, { role: 'system', content: playSkill }, { role: 'system', content: JSON.stringify({ character: { name: scrub(persona.name), persona: scrub(persona.persona) }, authority: 'personality-only' }) },
            { role: 'user', content: JSON.stringify({ round: { pilot: view.pilot, scope: view.scope, endsAtMs: view.endsAtMs, actionsRemaining: view.maxActions - view.actionsUsed }, trust: 'code-facts' }) }, ...context]
          if (Buffer.byteLength(JSON.stringify(messages)) > 28_000) throw new MemoryFailure('context-too-large')
          return { messages, eligibleIndexes: [] }
        } })
    },
    end,
    send: (text: string, requestId: string, hash: string) => { if (!harness || options.game().view().status !== 'playing') throw new Error('GAME_CHAT_UNAVAILABLE'); harness.send(scrub(text), requestId, hash) },
    events: (messages: readonly { id: number; text: string; sender: string }[]) => {
      if (!harness || !roundId || options.game().view().status !== 'playing' || eventCount >= 24) return
      const selected = messages.slice(0, 2).map((message) => ({ id: message.id, text: scrub(message.text), sender: scrub(message.sender) }))
      if (selected.length) { eventCount++; harness.postEvent('autonomous', JSON.stringify({ gameChat: selected, trust: 'untrusted-public-chat' }), 'minecraft:' + roundId + ':' + eventCount) }
    },
    stop: (taskId: string) => harness?.stop(taskId) ?? false,
    view: (): { messages: readonly MessageView[]; activities: readonly ActivityView[]; task: TaskView | null } => {
      const view = store?.projection(); return { messages: view?.messages ?? [], activities: view?.activities ?? [], task: view?.task ?? null }
    },
    idle: async () => { await harness?.idle(); await closing },
  }
}
export type MinecraftChat = ReturnType<typeof createMinecraftChat>

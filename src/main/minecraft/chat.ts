import { join } from 'node:path'
import { z } from 'zod'
import type { MessageView, ActivityView, TaskView } from '../../shared'
import type { Clock } from '../clock'
import type { ModelClient } from '../model/types'
import type { SessionStore } from '../store/session'
import { openSessionStore } from '../store/session'
import { createHarness } from '../harness/loop'
import type { HarnessTool } from '../harness/tools'
import { MemoryFailure } from '../memory/model'
import { sessionDayKey } from '../journal/file'
import { redactFixed } from '../privacy/redact'
import type { MinecraftService } from './service'
import definitions from './tools.json'
import policy from './policy.json'

/** Separate game journals/projection/harness: ordinary model input, memories and private saves never
 * read this root. Only attempt counters are mirrored into the main journal for the shared budget.
 */
export function createMinecraftChat(options: { root: string; clock: Clock; mainStore: SessionStore; model: ModelClient;
  game(): MinecraftService; enabled(): boolean; persona(): { name: string; persona: string }; credentials: readonly string[]; changed(): void }) {
  let store: SessionStore | undefined; let harness: ReturnType<typeof createHarness> | undefined; let closing: Promise<void> | undefined
  let roundId: string | undefined; let eventCount = 0
  const scrub = (value: string) => options.credentials.reduce((text, credential) => credential ? text.replaceAll(credential, '[redacted]') : text, redactFixed(value))
  const tools: HarnessTool[] = definitions.map((definition) => ({ definition, templateId: 'minecraft.' + definition.name,
    validate: (input) => z.fromJSONSchema(definition.parameters as Parameters<typeof z.fromJSONSchema>[0]).safeParse(input).success,
    run: async (input, context) => { const value = z.json().parse(await options.game().tool(definition.name, input, context.signal)); return { ok: true, raw: value, visible: value } },
  }))
  const end = () => {
    if (closing) return closing
    const oldHarness = harness; const oldStore = store; harness = undefined; store = undefined; roundId = undefined
    closing = (async () => { await oldHarness?.dispose(); oldStore?.close() })().finally(() => { closing = undefined; options.changed() }); return closing
  }
  return {
    ready: () => options.enabled() && !closing,
    begin: (id: string) => {
      if (store || closing || !options.enabled()) throw new Error('GAME_CHAT_UNAVAILABLE')
      roundId = id; eventCount = 0; store = openSessionStore(join(options.root, id), { userId: options.mainStore.scope.userId, characterId: options.mainStore.scope.characterId }, options.clock)
      const current = store
      const model: ModelClient = { source: options.model.source, complete: async (request, onAttempt) => {
        const reservation = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools })) + (request.maxOutputTokens ?? 800) + 1024
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
      harness = createHarness({ clock: options.clock, store: current, model, tools, getTools: () => tools.filter((tool) => tool.definition.name !== 'minecraft_chat' || options.game().view().scope?.allowChat), limits: { steps: 8, dailyTokens: 60_000, autonomousTokens: 60_000, outputTokens: 800 },
        enabled: () => options.enabled() && options.game().view().status === 'playing', changed: options.changed,
        prepareContext: async (_id, signal) => {
          signal.throwIfAborted(); const view = options.game().view(); const persona = options.persona()
          const messages = [{ role: 'system' as const, content: policy.system }, { role: 'system' as const, content: JSON.stringify({ character: { name: scrub(persona.name), persona: scrub(persona.persona) }, authority: 'personality-only' }) },
            { role: 'user' as const, content: JSON.stringify({ round: { pilot: view.pilot, scope: view.scope, endsAtMs: view.endsAtMs, actionsRemaining: view.maxActions - view.actionsUsed }, trust: 'code-facts' }) }, ...current.projection().context]
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

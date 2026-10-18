import { randomUUID } from 'node:crypto'
import type { ProviderConfig, ProviderSlot } from '../config/providers'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { MemoryModel } from '../memory/model'
import { memoryModelInput } from '../memory/seen'
import { MemoryFailure } from '../memory/model'
import type { EmailPrivacyModel } from '../mail/privacy'
import type { DocumentPrivacyModel } from '../documents/privacy'
import type { PrivacyModel } from '../privacy/filter'
import { redactFixed, redactSecrets } from '../privacy/redact'
import { sessionDayKey } from '../journal/file'
import { createModelClient } from './client'
import { parseModelJson } from './parse-json'
import { ModelFailure } from './types'
import prompts from './task-prompts.json'
import diaryPrompts from '../diary/prompts.json'
import { BUILTIN_CARD } from '../characters/builtin-persona'
import type { DiaryModel } from '../diary/schema'
import notificationPrompts from '../notifications/prompts.json'
import delegatePrompts from '../delegates/prompts.json'
import type { DelegateModel } from '../delegates/schema'
import { workModelInput, workOutput, type LifeWorkModel } from '../life/work/schema'
import workProtocol from '../life/work/protocol.json'
import { ResourceFailure, type ResourceAdmissions } from '../resources/ledger'

/** Machine JSON tasks only. Persona, diary and dream wording remain on the voice line. */
export function createTaskModelPorts(providers: ReadonlyMap<ProviderSlot, ProviderConfig>, clock: Clock, store: SessionStore, fetcher?: Parameters<typeof createModelClient>[3], budget?: ResourceAdmissions, followMain = false) {
  const clients = { background: createModelClient(providers, ['background'], clock, fetcher), privacy: createModelClient(providers, ['privacy'], clock, fetcher), chat: createModelClient(providers, ['chat'], clock, fetcher) }
  const json = async (slot: keyof typeof clients, prompt: string, input: unknown, parent: AbortSignal, maxOutputTokens: number, preserveSourceIds = false, trustedMain = false, bucket: 'work' | 'autonomous' = slot === 'privacy' ? 'work' : 'autonomous', timeoutMs = 30_000): Promise<unknown> => {
    const abort = new AbortController(); const signal = AbortSignal.any([parent, abort.signal]); signal.throwIfAborted()
    const stop = clock.after(timeoutMs, () => abort.abort()); const turnId = randomUUID()
    // SeenFragment.text was already scrubbed; its generated provenance IDs must remain exact for validation.
    const serialized = JSON.stringify(input); const content = trustedMain ? [...providers.values()].reduce((text, provider) => text.replaceAll(provider.api_key, '[密钥已遮盖]'), redactSecrets(serialized)) : preserveSourceIds ? serialized : redactFixed(serialized); const reservation = Buffer.byteLength(content) + maxOutputTokens + 2048
    let remove = () => {}
    try {
      const pending = clients[slot].complete({ messages: [{ role: 'system', content: prompt }, { role: 'user', content }], tools: [], signal, toolsExecuted: false, maxOutputTokens }, (attempt) => {
        let resourceReservationId: string | undefined
        if (attempt.status === 'started') {
          const rows = (store.history?.() ?? store.records()).filter((row) => row.type === 'model/attempt' && row.status === 'started' && sessionDayKey(clock, row.atMs) === sessionDayKey(clock))
          const used = rows.reduce((sum, row) => sum + (row.type === 'model/attempt' ? row.reservedTokens ?? 0 : 0), 0)
          const autonomous = rows.reduce((sum, row) => sum + (row.type === 'model/attempt' && row.bucket === 'autonomous' ? row.reservedTokens ?? 0 : 0), 0)
          if (!budget && (used + reservation > 500_000 || bucket === 'autonomous' && autonomous + reservation > 100_000)) throw new MemoryFailure('budget-exceeded')
          resourceReservationId = budget?.reserveModel(reservation, bucket)
        }
        // Private task inputs and output prose are never stored, even in model/seen or raw tool fields.
        store.append({ type: 'model/attempt', turnId, ...attempt, bucket, ...(attempt.status === 'started' ? { reservedTokens: reservation, ...(resourceReservationId ? { resourceReservationId } : {}) } : {}) })
      })
      const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => { const listener = () => reject(new ModelFailure(parent.aborted ? 'cancelled' : 'timeout')); signal.addEventListener('abort', listener, { once: true }); remove = () => signal.removeEventListener('abort', listener); if (signal.aborted) listener() })])
      signal.throwIfAborted(); if (result.toolCalls.length) throw new ModelFailure('invalid-output')
      return parseModelJson(result.text)
    } catch (error) { if (error instanceof ResourceFailure) throw new MemoryFailure(error.code === 'budget-exceeded' ? 'budget-exceeded' : 'unavailable'); throw error }
    finally { stop(); remove(); abort.abort() }
  }
  const memory: MemoryModel | null = providers.has('background') ? { source: 'real', extract: (input, signal) => json('background', prompts.memoryExtract, memoryModelInput(input), signal, 4096, true), summarize: (input, signal) => json('background', prompts.memorySummary, memoryModelInput(input), signal, 4096, true) } : null
  const mailSlot = followMain ? 'chat' : 'privacy'
  const mail: EmailPrivacyModel | null = providers.has(mailSlot) ? { source: 'real', isolated: !followMain, extract: (input, signal) => json(mailSlot, prompts.mail + '\n' + notificationPrompts.mailAddition, input, signal, 2048, false, followMain, 'work') } : null
  const document: DocumentPrivacyModel | null = providers.has('privacy') ? { source: 'real', ready: true, organize: (input, signal) => json('privacy', prompts.document, input, signal, 8192, false, false, 'work', 90_000) } : null
  const mainDocument: DocumentPrivacyModel | null = providers.has('chat') ? { source: 'real', ready: true, isolated: false, organize: (input, signal) => json('chat', prompts.document, input, signal, 8192, false, true, 'work', 90_000) } : null
  const narrow: PrivacyModel | null = providers.has('privacy') ? { source: 'real', extract: (text, signal) => json('privacy', prompts.narrowPrivacy, { text }, signal ?? new AbortController().signal, 512) } : null
  const diary: DiaryModel | null = providers.has('background') ? { source: 'real', write: (input, signal) => { const card = (store.history?.() ?? store.records()).findLast((row) => row.type === 'character/definition'); return json('background', diaryPrompts.system, { character: { name: store.projection().onboarding.characterName, persona: card?.type === 'character/definition' ? card.definition.persona : BUILTIN_CARD.persona }, fragments: input }, signal, 1600, true) } } : null
  const delegate: DelegateModel | null = providers.has('background') ? { source: 'real', read: (input, signal) => json('background', delegatePrompts.system, input, signal, 1600, true) } : null
  const lifeWork: LifeWorkModel | null = providers.has('background') ? { source: 'real', produce: async (input, signal) => workOutput.parse(await json('background', workProtocol.system, workModelInput.parse(input), signal, 4096)) } : null
  return { memory, mail, document, mainDocument, narrow, diary, delegate, lifeWork }
}

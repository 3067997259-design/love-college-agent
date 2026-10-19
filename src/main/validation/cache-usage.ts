import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Clock } from '../clock'
import { PROVIDER_SLOTS, readModelProviders, type ProviderSlot } from '../config/providers'
import type { ContextMessage, JournalRecord } from '../journal/schema'
import { createModelClient } from '../model/client'
import { ModelFailure, type ModelAttempt } from '../model/types'
import { openSessionStore } from '../store/session'

/**
 * M1 real-provider acceptance probe. Synthetic prompts only; the report carries numbers, booleans and
 * slot/shape enums. Credentials, URLs, model names and response text never leave the main process.
 * Bounded to MAX_CALLS and MAX_TOTAL_INPUT_TOKENS; it does not retry failures and does not run unless
 * the operator opted in with LCA_REAL_MODEL=1.
 */
const MAX_CALLS = 6
const MAX_TOTAL_INPUT_TOKENS = 20_000
const OUTPUT_TOKENS = 256
const CALL_TIMEOUT_MS = Math.min(90_000, Math.max(5_000, Number(process.env.LCA_CACHE_PROBE_TIMEOUT_MS) || 20_000))

type Shape = 'deepseek' | 'openai-compatible' | 'none' | 'unreported'
interface RawUsage { promptTokens: number; completionTokens: number; hit: number | null; miss: number | null; cached: number | null }
interface Capture { fetcher: (url: string, options: RequestInit) => Promise<Response>; flush: () => Promise<void>; raw: () => RawUsage | null }
type AttemptRow = Extract<JournalRecord, { type: 'model/attempt' }>
interface CallEntry {
  label: string; slot: ProviderSlot; turnId: string; outcome: 'ok' | 'failed'; shape: Shape | null; error?: string; status: number | null
  promptTokens: number; completionTokens: number
  rawHit: number | null; rawMiss: number | null; rawCached: number | null
  expectedCached: number | null; expectedUncached: number | null
  attemptCached: number | null; attemptUncached: number | null
  journalCached: number | null; journalUncached: number | null
  usageMatches: boolean; missingStaysAbsent: boolean
}
interface PairEntry { slot: ProviderSlot; firstCached: number | null; secondCached: number | null; secondUncached: number | null; hitObserved: boolean }

const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null

function pickUsage(value: unknown): RawUsage | null {
  if (!value || typeof value !== 'object') return null
  const usage = value as Record<string, unknown>
  const promptTokens = numeric(usage.prompt_tokens); const completionTokens = numeric(usage.completion_tokens)
  if (promptTokens === null || completionTokens === null || promptTokens < 0 || completionTokens < 0) return null
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object' ? usage.prompt_tokens_details as Record<string, unknown> : null
  return { promptTokens, completionTokens, hit: numeric(usage.prompt_cache_hit_tokens), miss: numeric(usage.prompt_cache_miss_tokens), cached: details ? numeric(details.cached_tokens) : null }
}

/** Captures only numeric usage frames from a clone of the provider response; response text is never stored. */
async function readUsageFrames(response: Response, into: RawUsage[]): Promise<void> {
  const reader = response.body?.getReader(); if (!reader) return
  const decoder = new TextDecoder('utf-8'); let buffer = ''; let bytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break
      bytes += value.byteLength; if (bytes > 2 * 1024 * 1024) break
      buffer += decoder.decode(value, { stream: true })
      let separator: RegExpExecArray | null
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index); buffer = buffer.slice(separator.index + separator[0].length)
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        try {
          const parsed: unknown = JSON.parse(data)
          const usage = pickUsage(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).usage : undefined)
          if (usage) into.push(usage)
        } catch { /* Evidence capture must never fail the real request. */ }
      }
    }
  } catch { /* A broken clone is not a model failure. */ }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function captureFetcher(): Capture {
  const usages: RawUsage[] = []; const pending: Promise<void>[] = []
  const fetcher = async (url: string, options: RequestInit) => {
    const response = await fetch(url, options)
    if (response.ok && response.body) pending.push(readUsageFrames(response.clone(), usages))
    return response
  }
  return { fetcher, flush: async () => { await Promise.allSettled(pending) }, raw: () => usages.at(-1) ?? null }
}

/** Mirrors the parser's normalisation so the probe compares against what the provider actually reported. */
function normalise(raw: RawUsage | null) {
  if (!raw) return { cached: null, uncached: null }
  const hit = raw.hit ?? raw.cached
  const reportedHit = hit !== null && hit <= raw.promptTokens ? hit : null
  const reportedMiss = raw.miss !== null && raw.miss <= raw.promptTokens ? raw.miss : null
  const cached = reportedHit ?? (reportedMiss !== null ? raw.promptTokens - reportedMiss : null)
  const uncached = reportedMiss ?? (cached !== null ? raw.promptTokens - cached : null)
  return { cached, uncached }
}

function pickShape(raw: RawUsage | null): Shape {
  if (!raw) return 'unreported'
  if (raw.hit !== null || raw.miss !== null) return 'deepseek'
  if (raw.cached !== null) return 'openai-compatible'
  return 'none'
}

const attemptRows = (records: readonly JournalRecord[]) => records.filter((row): row is AttemptRow => row.type === 'model/attempt')
const fields = (row: { cachedInputTokens?: number; uncachedInputTokens?: number } | undefined) =>
  ({ cached: row?.cachedInputTokens ?? null, uncached: row?.uncachedInputTokens ?? null })

export async function probeCacheUsage(dataDir: string, filename: string, clock: Clock) {
  if (process.env.LCA_REAL_MODEL !== '1') return { ok: false, probe: 'cache-usage', error: 'REAL_MODEL_NOT_AUTHORIZED' }
  const providers = await readModelProviders(filename)
  if (!providers.has('chat')) return { ok: false, probe: 'cache-usage', error: 'NOT_CONFIGURED' }
  const slots = PROVIDER_SLOTS.filter((slot) => providers.has(slot))
  const owner = { userId: 'probe-user', characterId: 'probe-character' }
  let store: ReturnType<typeof openSessionStore>
  try { store = openSessionStore(dataDir, owner, clock) } catch { return { ok: false, probe: 'cache-usage', error: 'SESSION_STORE_UNAVAILABLE' } }

  const calls: CallEntry[] = []
  let totalInputTokens = 0; let totalOutputTokens = 0; let budgetExceeded = false
  const prefix = Array.from({ length: 70 }, (_, index) => `Synthetic cache-prefix line ${randomUUID().slice(0, 8)} ${index} for provider prefix-caching verification.`).join('\n')

  const run = async (label: string, slot: ProviderSlot, content: string): Promise<CallEntry | null> => {
    if (calls.length >= MAX_CALLS || totalInputTokens >= MAX_TOTAL_INPUT_TOKENS) { budgetExceeded = true; return null }
    const turnId = randomUUID(); const capture = captureFetcher(); const abort = new AbortController()
    const stop = clock.after(CALL_TIMEOUT_MS, () => abort.abort())
    const attempts: ModelAttempt[] = []
    try {
      const messages: ContextMessage[] = [{ role: 'user', content }]
      const client = createModelClient(providers, [slot], clock, capture.fetcher)
      const reply = await client.complete({ messages, tools: [], signal: abort.signal, toolsExecuted: false, maxOutputTokens: OUTPUT_TOKENS }, (attempt) => {
        attempts.push(attempt)
        store.append({ type: 'model/attempt', turnId, ...attempt, bucket: 'work' })
      })
      await capture.flush()
      const raw = capture.raw(); const shape = pickShape(raw); const expected = normalise(raw)
      const success = attempts.filter((attempt) => attempt.status === 'success').at(-1)
      const journal = fields(attemptRows(store.records()).filter((row) => row.turnId === turnId && row.status === 'success').at(-1))
      const attempt = fields(success)
      const promptTokens = raw?.promptTokens ?? reply.usage.inputTokens
      const completionTokens = raw?.completionTokens ?? reply.usage.outputTokens
      totalInputTokens += promptTokens; totalOutputTokens += completionTokens
      const entry: CallEntry = {
        label, slot, turnId, outcome: 'ok', shape, status: 200,
        promptTokens, completionTokens,
        rawHit: raw?.hit ?? null, rawMiss: raw?.miss ?? null, rawCached: raw?.cached ?? null,
        expectedCached: expected.cached, expectedUncached: expected.uncached,
        attemptCached: attempt.cached, attemptUncached: attempt.uncached,
        journalCached: journal.cached, journalUncached: journal.uncached,
        usageMatches: attempt.cached === expected.cached && attempt.uncached === expected.uncached
          && journal.cached === expected.cached && journal.uncached === expected.uncached,
        missingStaysAbsent: (attempt.cached === null) === (expected.cached === null) && (attempt.uncached === null) === (expected.uncached === null)
          && (journal.cached === null) === (expected.cached === null) && (journal.uncached === null) === (expected.uncached === null),
      }
      calls.push(entry)
      return entry
    } catch (error) {
      calls.push({ label, slot, turnId, outcome: 'failed', shape: null, error: error instanceof ModelFailure ? error.kind : 'unknown',
        status: error instanceof ModelFailure ? error.httpStatus ?? null : null,
        promptTokens: 0, completionTokens: 0, rawHit: null, rawMiss: null, rawCached: null, expectedCached: null, expectedUncached: null,
        attemptCached: null, attemptUncached: null, journalCached: null, journalUncached: null, usageMatches: false, missingStaysAbsent: false })
      return null
    } finally { stop(); abort.abort() }
  }

  const pairs: PairEntry[] = []
  try {
    for (const slot of slots) await run('short-' + slot, slot, 'Reply with OK only. This is a synthetic provider cache-usage check.')
    const deepseek = calls.find((call) => call.outcome === 'ok' && call.shape === 'deepseek')
    const requested = (process.env.LCA_CACHE_PROBE_PAIR_SLOTS ?? '').split(',').map((value) => value.trim())
      .filter((value) => (PROVIDER_SLOTS as readonly string[]).includes(value)) as ProviderSlot[]
    const targets = (requested.length ? requested : deepseek ? [deepseek.slot] : [])
      .filter((slot) => calls.some((call) => call.outcome === 'ok' && call.slot === slot))
    if (process.env.LCA_CACHE_PROBE_PAIR !== '0') for (const slot of targets) {
      const first = await run('pair-first-' + slot, slot, prefix + '\nReply with OK.')
      if (first?.outcome !== 'ok') continue
      const second = await run('pair-second-' + slot, slot, prefix + '\nReply with OK!')
      if (second?.outcome === 'ok') pairs.push({ slot, firstCached: first.rawHit ?? first.rawCached, secondCached: second.rawHit ?? second.rawCached, secondUncached: second.expectedUncached, hitObserved: (second.rawHit ?? second.rawCached ?? -1) > 0 })
    }
  } finally { store.close() }

  let journalReopened: boolean
  const live = calls.filter((call) => call.outcome === 'ok')
  try {
    const reopened = openSessionStore(dataDir, owner, clock)
    try {
      const rows = attemptRows(reopened.records()).filter((row) => row.status === 'success')
      journalReopened = live.length > 0 && live.every((call) => rows.some((row) => row.turnId === call.turnId
        && (row.cachedInputTokens ?? null) === call.journalCached && (row.uncachedInputTokens ?? null) === call.journalUncached))
    } finally { reopened.close() }
  } catch { journalReopened = false }

  const shapes = {
    deepseekObserved: live.some((call) => call.shape === 'deepseek'),
    openaiCompatibleObserved: live.some((call) => call.shape === 'openai-compatible'),
    usageWithoutCacheObserved: live.some((call) => call.shape === 'none'),
    usageUnreported: live.some((call) => call.shape === 'unreported'),
  }
  const checks = {
    valuesMatch: live.every((call) => call.usageMatches),
    missingStaysAbsent: live.every((call) => call.missingStaysAbsent),
    journalReopened,
    cacheHitObserved: pairs.some((pair) => pair.hitObserved),
  }
  const report = {
    ok: !budgetExceeded && shapes.deepseekObserved && shapes.openaiCompatibleObserved && checks.valuesMatch && checks.missingStaysAbsent && checks.journalReopened,
    probe: 'cache-usage', realModel: true, syntheticPrompts: true,
    budget: { maxCalls: MAX_CALLS, calls: calls.length, maxInputTokens: MAX_TOTAL_INPUT_TOKENS, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, callTimeoutMs: CALL_TIMEOUT_MS },
    shapes, pairs, pair: pairs[0] ?? null, checks, journalReopened, calls,
    failures: calls.filter((call) => call.outcome === 'failed').map((call) => ({ label: call.label, slot: call.slot, error: call.error ?? 'unknown', status: call.status ?? null })),
  }
  const target = process.env.LCA_CACHE_PROBE_REPORT
  if (target) {
    try { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(report, null, 2), { mode: 0o600 }) } catch { /* The console report still returns the evidence. */ }
  }
  return report
}

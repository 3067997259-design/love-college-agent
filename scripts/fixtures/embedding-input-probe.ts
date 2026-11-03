// Supplemental production-adapter probe; the normal-product memory story stays separate.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { systemClock, type Clock } from '../../src/main/clock'
import { createApiMemoryEmbeddingSource } from '../../src/main/memory/airi/embedding'
import { createResourceBudget } from '../../src/main/resources/service'
import { createContinuityProbeBudget, type ContinuityProbeLimits } from './continuity-live-budget'
import plan from '../embedding-input-plan.json'

export const embeddingInputLimits = Object.freeze(plan.limits)
const cases = [
  { kind: 'document' as const, text: '这条合成记忆记录：我平时喜欢喝茶。' },
  { kind: 'query' as const, text: '这条合成记忆里，我平时喜欢喝什么？' },
]
type Configuration = { baseUrl: string; apiKey: string; model: string }
type Sample = {
  inputType: 'document' | 'query'; inputCharacters: number; status: number | null
  phase: 'admission' | 'request' | 'response' | 'complete'; ok: boolean; dimensions: number | null
  elapsedMs: number; usage?: { promptTokens: number; totalTokens: number }
}

/** Fetch is injected so offline checks exercise the exact production request construction. */
export async function checkEmbeddingInputTypes(input: {
  configuration: Configuration; clock: Clock; transport: typeof fetch
  reserve: (units: number, bucket: 'work' | 'autonomous') => void
  limits?: ContinuityProbeLimits; persist?: (report: object) => void
}) {
  const budget = createContinuityProbeBudget(input.limits ?? embeddingInputLimits, input.reserve)
  const samples: Sample[] = []
  const report = { ok: false, error: null as string | null, coverage: 'production-adapter input roles, not retrieval quality',
    samples, forwardedRequests: 0, counts: budget.view() }
  const save = () => { report.counts = budget.view(); input.persist?.(report) }
  try {
    let current: typeof cases[number], sample: Sample
    const source = createApiMemoryEmbeddingSource({ ...input.configuration, clock: input.clock,
      fetch: async (url, init) => {
        assert.equal(sample.phase, 'admission', 'REPEATED_PARAMETER_REQUEST')
        const body = JSON.parse(String(init?.body))
        assert.deepEqual(body, { model: input.configuration.model, input: current.text, input_type: current.kind }, 'INPUT_ROLE_MISMATCH')
        assert.equal(init?.method, 'POST', 'METHOD_CHANGED')
        budget.embedding(current.kind, current.text); sample.phase = 'request'; save()
        report.forwardedRequests++; save()
        // Do not follow redirects with the authorized credential.
        const response = await input.transport(url, { ...init, redirect: 'error' })
        sample.status = response.status; sample.phase = 'response'; save()
        return response
      },
    })
    assert.equal(source.provider, 'voyage', 'VOYAGE_CONNECTION_REQUIRED')
    for (current of cases) {
      sample = { inputType: current.kind, inputCharacters: current.text.length, status: null, phase: 'admission', ok: false, dimensions: null, elapsedMs: 0 }
      samples.push(sample); save()
      const started = input.clock.nowMs()
      try {
        const vector = await source.embed(current.text, current.kind)
        sample.dimensions = vector.length
        assert.equal(vector.length, samples[0].dimensions, 'VECTOR_DIMENSIONS_CHANGED')
        sample.usage = source.getLastUsage?.()
        sample.ok = true; sample.phase = 'complete'
      } finally { sample.elapsedMs = input.clock.nowMs() - started; save() }
    }
    report.ok = samples.length === 2 && samples.every(sample => sample.ok)
  } catch {
    // Never serialize upstream errors, URLs or configuration values.
    report.error = samples.length ? 'EMBEDDING_PARAMETER_CHECK_FAILED' : 'VOYAGE_CONNECTION_REQUIRED'
  } finally { save() }
  return report
}

/** Only the authorized isolated Electron main opens the saved connection. */
export async function runEmbeddingInputProbe(input: { root: string; selfTest: boolean; authorized?: string }) {
  assert.ok(process.versions.electron, 'ELECTRON_MAIN_REQUIRED')
  const configuration: Configuration = input.selfTest
    ? { baseUrl: 'https://api.voyageai.com/v1', apiKey: 'synthetic-only', model: 'probe-voyage' }
    : JSON.parse(readFileSync(input.authorized!, 'utf8')).embedding
  assert.ok(configuration && typeof configuration.baseUrl === 'string' && typeof configuration.apiKey === 'string', 'EMBEDDING_CONFIGURATION_INVALID')
  if (!input.selfTest) assert.equal(configuration.model, plan.expectedModel, 'AUTHORIZED_MODEL_CHANGED')
  const ledger = createResourceBudget({ root: join(input.root, 'budget'), clock: systemClock, configurable: true })
  try {
    assert.equal(ledger.dispatch({ protocolVersion: 1, epoch: 'embedding-probe', requestId: 'limits',
      type: 'resources.configure', dailyTotalUnits: embeddingInputLimits.maximumReservedUnits, dailyAutonomousUnits: embeddingInputLimits.maximumAutonomousUnits }), undefined)
    const annotate = (report: object) => ({ ...report, selfTest: input.selfTest, limits: embeddingInputLimits, upstreamRequests: input.selfTest ? 0 : (report as { forwardedRequests: number }).forwardedRequests })
    const result = await checkEmbeddingInputTypes({ configuration, clock: systemClock,
      reserve: (units, bucket) => { ledger.reserveModel(units, bucket) },
      transport: input.selfTest
        ? async () => new Response(JSON.stringify({ data: [{ embedding: Array(1024).fill(0.25) }], usage: { prompt_tokens: 16, total_tokens: 16 } }))
        : fetch,
      persist: report => writeFileSync(join(input.root, 'report.json'), JSON.stringify(annotate(report), null, 2)),
    })
    return annotate(result)
  } finally { ledger.close() }
}

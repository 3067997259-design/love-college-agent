import { expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { resourceLimits } from '../../src/main/resources/ledger'
import { checkEmbeddingInputTypes, embeddingInputLimits } from '../../scripts/fixtures/embedding-input-probe'

const configuration = { baseUrl: 'https://api.voyageai.com/v1', apiKey: 'never-in-report', model: 'voyage-4-large' }
const response = (dimensions = 1024) => new Response(JSON.stringify({ data: [{ embedding: Array(dimensions).fill(0.5) }], usage: { prompt_tokens: 4, total_tokens: 4 } }))
const options = () => ({ configuration, clock: createManualClock(17), reserve: vi.fn() })

it('uses a budget accepted by the real append-only resource ledger', () => {
  expect(resourceLimits.safeParse({ dailyTotalUnits: embeddingInputLimits.maximumReservedUnits, dailyAutonomousUnits: embeddingInputLimits.maximumAutonomousUnits }).success).toBe(true)
})

it('uses production document/query construction and charges both before transport', async () => {
  const input = options()
  const transport = vi.fn<typeof fetch>(async () => { expect(input.reserve).toHaveBeenCalledTimes(transport.mock.calls.length); return response() })
  const result = await checkEmbeddingInputTypes({ ...input, transport })
  expect(result.ok).toBe(true)
  expect(result.counts.modelRequests).toBe(0)
  expect(result.counts.embeddingRequests).toBe(2)
  expect(result.counts.reservedUnits).toBe(result.counts.autonomousUnits)
  expect(result.samples.map(sample => [sample.inputType, sample.dimensions, sample.ok])).toEqual([['document', 1024, true], ['query', 1024, true]])
  expect(transport.mock.calls.map(call => JSON.parse(String(call[1]?.body)).input_type)).toEqual(['document', 'query'])
  expect(transport.mock.calls.every(call => call[1]?.redirect === 'error')).toBe(true)
  expect(JSON.stringify(result)).not.toContain(configuration.apiKey)
  expect(JSON.stringify(result)).not.toContain(configuration.baseUrl)
})

it('stops on the first HTTP failure without trying query or refunding the attempt', async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response('failed', { status: 503 }))
  const result = await checkEmbeddingInputTypes({ ...options(), transport })
  expect(result.ok).toBe(false); expect(result.samples).toHaveLength(1)
  expect(result.samples[0].status).toBe(503); expect(transport).toHaveBeenCalledTimes(1)
  expect(result.counts.embeddingRequests).toBe(1)
})

it('stops on malformed vectors and suppresses transport error details', async () => {
  for (const transport of [vi.fn<typeof fetch>(async () => response(7)), vi.fn<typeof fetch>(async () => { throw Error(configuration.apiKey + configuration.baseUrl) })]) {
    const result = await checkEmbeddingInputTypes({ ...options(), transport })
    expect(result.ok).toBe(false); expect(transport).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain(configuration.apiKey)
    expect(JSON.stringify(result)).not.toContain(configuration.baseUrl)
  }
})

it('refuses the second request before transport if its bounded allowance is exhausted', async () => {
  const transport = vi.fn<typeof fetch>(async () => response())
  const result = await checkEmbeddingInputTypes({ ...options(), transport, limits: { ...embeddingInputLimits, maximumEmbeddingRequests: 1 } })
  expect(result.ok).toBe(false); expect(transport).toHaveBeenCalledTimes(1)
  expect(result.samples[1].phase).toBe('admission')
  expect(result.counts.embeddingRequests).toBe(1)
})

it('does not call a generic gateway and fails if the two responses change vector space', async () => {
  const transport = vi.fn<typeof fetch>(async () => response())
  const rejected = await checkEmbeddingInputTypes({ ...options(), configuration: { ...configuration, baseUrl: 'http://127.0.0.1/v1' }, transport })
  expect(rejected.ok).toBe(false); expect(transport).not.toHaveBeenCalled()
  transport.mockImplementationOnce(async () => response()).mockImplementationOnce(async () => response(768))
  const changed = await checkEmbeddingInputTypes({ ...options(), transport })
  expect(changed.ok).toBe(false); expect(changed.samples[1].ok).toBe(false)
})

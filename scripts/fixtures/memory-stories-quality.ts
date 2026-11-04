import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { systemClock } from '../../src/main/clock'
import { createStoryQualityIO } from './memory-story-io'
import { createStoryHarness } from './memory-story-harness'
import { executeStory, storyIds, storyOracle } from './memory-story-cases'
import plan from '../memory-stories-plan.json'

export async function runMemoryStoriesQuality(input: { root: string; repo: string; runtime: string; bridge: string; selfTest: boolean; authorized?: string; embeddingConfig?: string; workInterruptionOnly?: boolean }) {
  assert.deepEqual([...plan.storyOrder].sort(), [...storyIds].sort(), 'STORY_ORDER_MUST_INCLUDE_EACH_FROZEN_CASE_ONCE')
  assert.deepEqual(plan.workInterruptionRetest.storyOrder, ['S16', 'S20'], 'INTERRUPTION_SCOPE_CHANGED')
  const scope = input.workInterruptionOnly ? plan.workInterruptionRetest : plan
  const order = scope.storyOrder
  const report = { ok: false, selfTest: input.selfTest, qualityPassed: null as boolean | null, coverage: plan.coverage, storageHost: 'packaged-production-utility',
    coverageScope: input.workInterruptionOnly ? 'work-interruption-only' : 'all-24-stories', fullSuitePassed: false, storyOrder: order,
    status: 'setup', currentStory: null as string | null, error: null as string | null, completed: [] as string[],
    reviews: [] as Record<string, unknown>[], upstreamRequests: 0, counts: {} }
  const save = () => writeFileSync(join(input.root, 'report.json'), JSON.stringify(report, null, 2))
  save()
  const io = await createStoryQualityIO({ ...input, limits: scope.limits })
  const reviewDir = join(input.root, 'reviews'); mkdirSync(reviewDir)
  let harness: Awaited<ReturnType<typeof createStoryHarness>> | undefined
  try {
    for (const id of order) {
      report.currentStory = id; report.status = 'running'; save()
      harness = await createStoryHarness({ ...input, id, io, root: join(input.root, id), mirrorOffline: id === 'S08' || id === 'S24' })
      const result = await executeStory(id, harness, input.repo)
      const body = JSON.stringify(result, null, 2), resultSha256 = createHash('sha256').update(body).digest('hex')
      writeFileSync(join(input.root, id + '.json'), body, { flag: 'wx' })
      await harness.close(); harness = undefined
      report.upstreamRequests = io.state().upstreamRequests; report.counts = io.state().counts
      if (!input.selfTest) {
        // A local evidence review is required before the next paid story. No oracle enters DSH.
        report.status = 'awaiting-semantic-review'; save()
        writeFileSync(join(input.root, 'review-ready.json'), JSON.stringify({ id, resultSha256, oracle: storyOracle(id),
          instruction: 'Review answer, successful-input references, actual tool/state/artifact evidence. Write reviews/<id>.json with id, resultSha256, verdict pass|fail|inconclusive, and reason. No keyword-only verdict.' }, null, 2))
        const path = join(reviewDir, id + '.json')
        const review = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const cancel = systemClock.after(30 * 60_000, () => { watcher?.close(); reject(new Error('SEMANTIC_REVIEW_TIMEOUT')) })
          const read = () => {
            if (!existsSync(path)) return
            try { const value = JSON.parse(readFileSync(path, 'utf8')); watcher?.close(); cancel(); resolve(value) }
            catch { /* Atomic rename can be used by the reviewer; a partial write never authorizes advancement. */ }
          }
          const watcher = watch(reviewDir, read); read()
        })
        assert.equal(review.id, id); assert.equal(review.resultSha256, resultSha256); assert.equal(typeof review.reason, 'string')
        report.reviews.push(review); save(); assert.equal(review.verdict, 'pass', 'SEMANTIC_ACCEPTANCE_FAILED')
      }
      report.completed.push(id); report.status = 'story-completed'; save()
    }
    assert.deepEqual(report.completed, order)
    report.qualityPassed = input.selfTest ? null : report.reviews.length === order.length && report.reviews.every(item => item.verdict === 'pass')
    report.fullSuitePassed = !input.workInterruptionOnly && report.qualityPassed === true
    report.ok = input.selfTest || report.qualityPassed === true; report.status = 'complete'
  } catch (error) {
    report.status = 'failed'
    report.error = input.selfTest ? (error instanceof Error ? error.message : 'FIXTURE_FAILED')
      : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'STORY_ACCEPTANCE_FAILED'
  } finally {
    await harness?.close(); report.upstreamRequests = io.state().upstreamRequests; report.counts = io.state().counts
    await io.close(); save()
  }
  return report
}

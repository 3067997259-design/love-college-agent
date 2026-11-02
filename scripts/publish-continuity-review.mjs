// Publishes a completed human review atomically; never calls a model or changes a report.
import assert from 'node:assert/strict'
import { access, link, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

const [runPath, decisionPath] = process.argv.slice(2)
assert.ok(runPath && decisionPath, 'Usage: node scripts/publish-continuity-review.mjs <run-directory> <completed-decision.json>')
const root = resolve(runPath)
const run = JSON.parse(await readFile(join(root, 'run.json'), 'utf8'))
assert.ok(!run.selfTest && ['work', 'memory'].includes(run.batch), 'REAL_CONTINUITY_REVIEW_REQUIRED')
await access(join(root, 'answers-for-review.json'))
const finalized = await access(join(root, 'report.json')).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
})
assert.equal(finalized, false, 'BATCH_ALREADY_FINALIZED')
const review = JSON.parse(await readFile(resolve(decisionPath), 'utf8'))
assert.ok(review.batch === run.batch && typeof review.accepted === 'boolean' && typeof review.reason === 'string' && review.reason.trim(), 'INVALID_SEMANTIC_REVIEW')
const temporary = join(root, `.semantic-review-${randomUUID()}.tmp`)
await writeFile(temporary, JSON.stringify(review, null, 2), { flag: 'wx' })
try {
  // The watcher sees either no file or the complete, closed file. link refuses
  // an existing destination, preserving any earlier review even during a race.
  await link(temporary, join(root, 'semantic-review.json'))
} finally { await unlink(temporary) }
console.log(JSON.stringify({ batch: run.batch, reviewPublished: true }))

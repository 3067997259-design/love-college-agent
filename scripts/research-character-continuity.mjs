// Read-only source-level examples, not a model, database, Electron or product acceptance test.
// Node 24 strips type-only imports. AIRI is read from an explicit checkout and is never changed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { relevance, searchMemories } from '../src/main/memory/retrieval.ts'
import { groundedIn } from '../src/main/memory/grounding.ts'

const repo = resolve(import.meta.dirname, '..')
const airiRoot = process.argv[2] && resolve(process.argv[2])
if (!airiRoot) throw new Error('Usage: node scripts/research-character-continuity.mjs <AIRI checkout>')
const airi = await import(pathToFileURL(join(airiRoot, 'packages/memory-core/src/interaction.ts')).href)
const extraction = await import(pathToFileURL(join(airiRoot, 'packages/memory-core/src/extraction.ts')).href)
const samples = [
  { fact: '我偏爱猫咪', query: '喜欢什么宠物？', expected: 'relevant-paraphrase' },
  { fact: '咖啡会让我睡不着', query: '晚上要不要准备拿铁？', expected: 'relevant-paraphrase' },
  { fact: '我偏爱猫咪', query: '猫咪', expected: 'literal-positive-control' },
  { fact: '我偏爱咖啡色', query: '咖啡', expected: 'lexical-overlap-with-different-meaning' },
].map((sample, index) => {
  const item = { id: `example-${index}`, text: sample.fact, kind: 'fact', tier: 'short_term', reviewStatus: 'unreviewed', sources: [], createdAtMs: 0, lastMentionedAtMs: 0, accessCount: 0 }
  return { ...sample, relevance: relevance(sample.query, sample.fact), retrieved: searchMemories([item], sample.query, 0).length > 0 }
})
assert.equal(samples[0].retrieved, false)
assert.equal(samples[1].retrieved, false)
assert.equal(samples[2].retrieved, true)
assert.equal(samples[3].retrieved, true)
const grounding = [
  { source: '我偏爱猫咪', text: '我更喜欢猫', expected: 'valid-paraphrase-is-not-an-exact-quote' },
  { source: '我不喜欢咖啡', text: '喜欢咖啡', expected: 'unsafe-negation-removal-control' },
  { source: '我偏爱猫咪', text: '我偏爱猫咪', expected: 'exact-quote-positive-control' },
].map((sample) => ({ ...sample, verdict: groundedIn(sample.source, sample.text) }))
assert.equal(grounding[0].verdict.entailed, false)
assert.equal(grounding[1].verdict.entailed, false)
assert.equal(grounding[2].verdict.entailed, true)
// The same exact-ID directory stays usable with no vector; this is one AIRI mechanism, not retrieval quality.
const fact = { id: 'synthetic-fact', content: '用户偏爱猫咪。', memoryType: 'short_term', category: 'chat', reviewStatus: 'approved', factStatus: 'active', scope: { userId: 'synthetic-user', characterId: 'synthetic-character' }, pinned: true, revision: 1, title: '宠物偏好', summary: '偏爱猫咪', summaryRevision: 1 }
const directory = airi.buildMemoryDirectory([fact])
assert.equal(directory.entries.length, 1)
assert.equal(airi.buildMemoryDirectory([{ ...fact, reviewStatus: 'pending' }]).entries.length, 0)
assert.equal(airi.buildMemoryDirectory([{ ...fact, factStatus: 'superseded' }]).entries.length, 0)
assert.equal(airi.buildMemoryDirectory([{ ...fact, accessCount: 100, lastAccessed: 1234 }]).text, directory.text)
const parsed = extraction.parseMemoryTurnExtractions([{ content: fact.content, category: 'chat', memoryType: 'short_term' }], { sessionId: 'synthetic-session' })
assert.equal(parsed.length, 1)
const sources = {
  lca: ['src/main/memory/retrieval.ts', 'src/main/memory/grounding.ts', 'src/main/memory/model.ts', 'src/main/memory/service.ts', 'src/main/memory/projection.ts', 'src/main/memory/seen.ts', 'src/main/diary/service.ts', 'src/main/diary/prompts.json', 'src/main/life/service.ts', 'src/main/life/work/service.ts', 'src/main/life/work/schema.ts', 'src/main/life/work/protocol.json', 'src/main/attention/service.ts', 'src/main/index.ts', 'src/main/model/task-ports.ts'],
  airi: ['packages/memory-core/src/interaction.ts', 'packages/memory-core/src/extraction.ts', 'packages/memory-core/src/types.ts', 'packages/memory-core/src/score.ts', 'packages/memory-core/src/promotion.ts', 'packages/memory-core/src/dream.ts', 'packages/memory-core/src/source-context.ts', 'packages/stage-ui/src/stores/modules/memory.ts', 'packages/stage-ui/src/services/memory/local-memory.ts', 'packages/stage-ui/src/services/memory/interactions.ts', 'packages/stage-ui/src/tools/memory.ts', 'packages/memory-pgvector/src/repository.ts', 'docs/fork/memory-v3-state-repair-20261029.md', 'LICENSE'],
}
const report = {
  version: 1, node: process.version, date: '2026-10-31', kind: 'source-audit-and-pure-function-examples',
  userObservation: 'User reports never perceiving the world/life and diary effects triggering; no personal runtime profile was inspected.',
  lexicalExamples: samples, groundingExamples: grounding,
  airiPureMechanisms: { approvedPinnedFactWithoutVector: true, pendingExcluded: true, supersededExcluded: true, directoryStableAcrossAccessCounters: true, normalizedFactShapeAccepted: parsed.length === 1 },
  limits: ['These hand-selected examples are counterexamples, not a representative retrieval benchmark.', 'AIRI extraction parser acceptance does not prove semantic grounding, successful persistence or model behavior.', 'No actual embedding, remote mirror, model, Electron, database or user save was loaded.', 'Life and diary findings are source-level reachability/lifecycle findings, not a reproduction of the user daily-use environment.'],
  sources: Object.fromEntries(Object.entries(sources).map(([key, paths]) => [key, paths.map((path) => {
    const bytes = readFileSync(join(key === 'lca' ? repo : airiRoot, path))
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  })])),
}
const parent = join(repo, 'test-results', 'character-continuity')
mkdirSync(parent, { recursive: true })
const folder = mkdtempSync(join(parent, 'audit-'))
writeFileSync(join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: join(folder, 'report.json'), lexicalExamples: samples, groundingExamples: grounding, airiPureMechanisms: report.airiPureMechanisms }, null, 2))

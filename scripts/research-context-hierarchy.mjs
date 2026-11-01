// Characterize the existing calendar-summary projection with synthetic history.
// No model, database, Electron, user profile or third-party service is involved.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createManualClock } from '../src/main/clock/index.ts'
import { closedSummaryGroups, summaryReferences, validSummaries, summaryReferenceChars } from '../src/main/memory/hierarchy.ts'

const repo = resolve(import.meta.dirname, '..')
const clock = createManualClock(Date.parse('2026-11-01T12:00:00+08:00'))
const day = (date, text = date, revision = 1) => ({
  id: `day:${date}:v${revision}`, level: 'day', period: date, text, sources: [],
  sourceSessionIds: [`s:${date}`], source: 'fake',
})
const wider = (level, period, children, text) => ({
  id: `${level}:${period}`, level, period, text, sources: [], source: 'fake',
  sourceSessionIds: children.flatMap((item) => item.sourceSessionIds), parentSummaryIds: children.map((item) => item.id),
})
const select = (rows) => summaryReferences(validSummaries(rows), 's:2026-11-01', '2026-11-01', clock)
const cases = []
const record = (id, observation, details) => cases.push({ id, observation, details })

const septemberDays = [day('2026-09-14'), day('2026-09-15')]
const septemberWeek = wider('week', '2026-09-14', septemberDays, 'Week excerpt')
const groups = closedSummaryGroups([...septemberDays, septemberWeek], '2026-11-01', clock)
const monthGroup = groups.find((group) => group.level === 'month' && group.period === '2026-09')
assert.deepEqual(monthGroup.children.map((item) => item.id), septemberDays.map((item) => item.id))
record('C1', 'Month consolidation takes day summaries directly, not the available week summary.', { monthChildren: monthGroup.children.map((item) => item.id) })

const weekBoundaryDay = day('2026-10-25') // Exactly seven days ago: strict older-than test.
const olderWeekDay = day('2026-10-24')
const monthBoundaryDay = day('2026-10-02') // Exactly thirty days ago.
const olderMonthDay = day('2026-10-01')
const boundaries = [
  [weekBoundaryDay, wider('week', '2026-10-19', [weekBoundaryDay], 'week boundary'), 'day'],
  [olderWeekDay, wider('week', '2026-10-19', [olderWeekDay], 'older week'), 'week'],
  [monthBoundaryDay, wider('month', '2026-10', [monthBoundaryDay], 'month boundary'), 'day'],
  [olderMonthDay, wider('month', '2026-10', [olderMonthDay], 'older month'), 'month'],
].map(([child, parent, expected]) => {
  const actual = select([child, parent])[0].level
  assert.equal(actual, expected)
  return { day: child.period, candidate: parent.level, selected: actual }
})
record('C2', 'Age is a selection gate on covered source days, not a compulsory rewrite at day 7 or day 30.', boundaries)

const recentDays = Array.from({ length: 6 }, (_, index) => day(`2026-10-${26 + index}`, `Recent day ${index}`))
const septemberMonth = wider('month', '2026-09', septemberDays, 'Month excerpt')
const mixed = select([...septemberDays, septemberWeek, septemberMonth, ...recentDays, day('2026-11-01')])
assert.equal(mixed.length, 7)
assert.ok(mixed.some((item) => item.id === septemberMonth.id))
assert.ok(!mixed.some((item) => item.id === septemberWeek.id || item.period === '2026-11-01'))
const covered = mixed.flatMap((item) => item.sourceSessionIds)
assert.equal(new Set(covered).size, covered.length)
record('C3', 'Recent day references and an old month coexist; overlapping week/day references and the current session are excluded.', mixed.map(({ id, level }) => ({ id, level })))

const oldDay = day('2026-09-14', '当时计划周五交付')
const oldMonth = wider('month', '2026-09', [oldDay], oldDay.text)
const correctedDay = day('2026-09-14', '后来改为周六交付', 2)
const corrected = select([oldDay, oldMonth, correctedDay])
assert.deepEqual(corrected.map((item) => item.id), [correctedDay.id])
record('C4', 'Replacing a day-summary version invalidates its old wider summary and restores the corrected day reference.', { selected: corrected.map((item) => item.id) })

// No summary version is changed by merely recording a correction in another subsystem.
const correction = { type: 'synthetic-memory-correction', text: '现在改为周六交付' }
const unchanged = select([oldDay, oldMonth])
assert.deepEqual(unchanged.map((item) => item.text), [oldDay.text])
record('C5', 'The hierarchy has no input for a separate fact correction: callers must reconcile current facts with historical summaries.', { correction, selectedText: unchanged.map((item) => item.text), boundary: 'No AIRI integration is exercised here.' })

const orphan = { ...oldMonth, parentSummaryIds: ['missing-parent'] }
assert.equal(validSummaries([orphan]).length, 1)
record('C6', 'A missing declared parent is currently treated as unknown, not stale.', { valid: true })

const largeRecent = recentDays.map((item) => ({ ...item, text: '摘'.repeat(6000) }))
const bounded = select(largeRecent)
const totalChars = bounded.reduce((sum, item) => sum + item.text.length, 0)
assert.equal(totalChars, summaryReferenceChars)
assert.equal(bounded.find((item) => item.period === '2026-10-26').text.length, 2000)
record('C7', 'The shared 32000-character ceiling can truncate a reference while keeping its original source coverage metadata.', { totalChars, selected: bounded.map(({ period, text }) => ({ period, chars: text.length })) })

const sourcePaths = [
  'src/main/memory/hierarchy.ts', 'src/main/memory/service.ts', 'src/main/memory/model.ts',
  'src/main/memory/seen.ts', 'src/main/memory/repository.ts', 'src/main/journal/projection.ts',
  'src/main/dsh/execution.ts', 'src/main/dsh/host.ts', 'src/main/index.ts', 'src/main/bridge/controller.ts',
  'src/main/diary/service.ts', 'src/main/life/service.ts', 'src/main/backup/archive.ts',
  'dsh/lca-bridge/index.js', 'dsh/lca-bridge/profile.js', 'dsh/lca-bridge/provenance.js',
  'dsh/runtime/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
  'dsh/runtime/node_modules/@deepseek-ai/dsh-compaction-basic/README.zh.md',
  'dsh/runtime/node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts',
]
const report = {
  date: '2026-11-01', node: process.version, kind: 'source-characterization-with-synthetic-calendar-history',
  cases, limits: ['These cases characterize current pure functions, not desired integration acceptance.',
    'No native DSH compaction, model quality, persistent memory, diary or life behavior is executed.',
    'C5 demonstrates a missing input to this layer; it is not a run of AIRI or an end-to-end correction test.'],
  sources: sourcePaths.map((path) => { const bytes = readFileSync(join(repo, path)); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }),
}
const parent = join(repo, 'test-results', 'context-hierarchy')
mkdirSync(parent, { recursive: true })
const directory = mkdtempSync(join(parent, 'audit-'))
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: join(directory, 'report.json'), cases: cases.map(({ id, observation }) => ({ id, observation })) }, null, 2))

// Free preparation only: no provider/config read, no Electron/model launch.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, globSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { candidateFingerprint } from './continuity-candidate.mjs'

const root = resolve(process.env.LCA_CONTINUITY_RUN_DIR ?? process.argv[2] ?? '')
assert.ok(process.env.LCA_CONTINUITY_RUN_DIR || process.argv[2], 'SAME_CANDIDATE_REPORT_DIRECTORY_REQUIRED')
const run = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'))
assert.equal(run.ok, true, 'OFFLINE_CANDIDATE_NOT_PASSED')
assert.equal(run.source, candidateFingerprint(), 'SOURCE_CHANGED')
const bytes = readFileSync('scripts/continuity-live-plan.json'), plan = JSON.parse(bytes)
const evidence = plan.batches.map(batch => ({ batch: batch.id, tasks: batch.offlineEvidence.map(name => {
  const task = run.tasks.find(task => task.name === name); assert.equal(task?.code, 0, 'OFFLINE_EVIDENCE_MISSING:' + name)
  return { name, sha256: createHash('sha256').update(readFileSync(join(root, task.log))).digest('hex') }
}) }))
const pg = globSync('postgres-*/report.json', { cwd: root }).map(path => ({ path, ...JSON.parse(readFileSync(join(root, path), 'utf8')) }))
assert.equal(pg.length, 1, 'POSTGRES_ENVIRONMENT_REPORT_REQUIRED')
const output = { version: 1, source: run.source, planSha256: createHash('sha256').update(bytes).digest('hex'), authorized: false,
  proposedOnly: true, executionRequestsMade: 0, plan, evidence, postgres: pg,
  readiness: 'offline evidence and bounded scenarios ready; live runner wiring/preflight and explicit batch authorization still required',
  unitDefinition: 'Reserved units are admission estimates, not money or measured provider billing.',
  scope: 'Work only in synthetic temporary projects. Main/normal data and the current manual instance are excluded.' }
writeFileSync(join(root, 'live-authorization-request.json'), JSON.stringify(output, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ readyForReview: true, authorized: false, report: join(root, 'live-authorization-request.json'), batches: plan.batches.map(({ id, maximumModelRequests, maximumReservedUnits, maximumAutonomousUnits }) => ({ id, maximumModelRequests, maximumReservedUnits, maximumAutonomousUnits })) }))

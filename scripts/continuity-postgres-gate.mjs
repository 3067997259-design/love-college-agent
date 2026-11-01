// A private, disposable Docker DB only. Never consumes an ambient DATABASE_URL.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.env.LCA_CONTINUITY_RUN_DIR ?? 'test-results/continuity', 'postgres-' + randomUUID())
mkdirSync(join(root, 'docker-config'), { recursive: true })
const container = 'lca-continuity-pg-' + randomUUID()
const report = { status: 'unavailable', realPostgres: false, container, reason: null, checks: [] }
const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
const docker = args => spawnSync('docker', ['--config', join(root, 'docker-config'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
let created = false
try {
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) report.reason = 'DOCKER_UNAVAILABLE'
  else {
    const image = docker(['image', 'inspect', process.env.LCA_TEST_PGVECTOR_IMAGE ?? 'pgvector/pgvector:pg16', '--format', '{{.Id}}'])
    if (image.status !== 0) report.reason = 'LOCAL_PGVECTOR_IMAGE_MISSING'
    else {
      report.imageId = image.stdout.trim()
      const password = randomUUID() // synthetic disposable credential, never a daily DB
      const started = docker(['run', '-d', '--name', container, '--label', 'lca.continuity-test=true', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_DB=lca_acceptance', '-e', 'POSTGRES_PASSWORD=' + password, report.imageId])
      if (started.status !== 0) throw new Error('ISOLATED_DATABASE_START_FAILED')
      created = true
      const port = docker(['port', container, '5432/tcp']).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1]
      if (!port) throw new Error('ISOLATED_PORT_MISSING')
      let ready = false
      for (let i = 0; i < 60; i++) {
        if (docker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'lca_acceptance']).status === 0) { ready = true; break }
        await new Promise(done => setTimeout(done, 500))
      }
      if (!ready) throw new Error('DATABASE_NOT_READY')
      const output = join(root, 'unit.json')
      const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/unit/airi/pgvector/repository.integration.test.ts', 'tests/unit/airi/pgvector/recovery.integration.test.ts', '--no-file-parallelism', '--reporter=json', '--outputFile=' + output], {
        encoding: 'utf8', windowsHide: true, timeout: 240_000,
        env: { ...process.env, LCA_MEMORY_TEST_POSTGRES: '1', LCA_MEMORY_TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/lca_acceptance`, LCA_TEST_PG_CONTAINER: container, LCA_TEST_DOCKER_CONFIG: join(root, 'docker-config') },
      })
      // Error output can contain connection URLs. Keep only sanitized totals.
      if (run.status !== 0) throw new Error('POSTGRES_TESTS_FAILED')
      const unit = JSON.parse(readFileSync(output, 'utf8'))
      if (unit.numPendingTests || unit.numFailedTests || unit.numPassedTests !== 6) throw new Error('POSTGRES_TESTS_INCOMPLETE')
      report.checks = unit.testResults.flatMap(suite => suite.assertionResults.map(test => test.fullName))
      report.status = 'passed'; report.realPostgres = true
    }
  }
} catch (error) { report.status = 'failed'; report.reason = error.message; process.exitCode = 1 }
finally {
  // Retain this run's DB volume for reconciliation. Never touch any other container.
  if (created) { report.containerStopped = docker(['stop', container]).status === 0; if (!report.containerStopped) { report.status = 'failed'; report.reason = 'CONTAINER_STOP_FAILED'; process.exitCode = 1 } }
  save()
}
console.log(JSON.stringify({ ...report, report: join(root, 'report.json') }))

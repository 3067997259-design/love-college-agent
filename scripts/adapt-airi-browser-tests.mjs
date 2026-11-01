// One-time import: retain the upstream assertions, replace browser ownership/IO only.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const target = 'tests/unit/airi/interactions-native.test.ts'
if (existsSync(target)) throw new Error('REFUSE_OVERWRITE')
let source = readFileSync('vendor/airi-memory/increment/packages/stage-ui/src/services/memory/interactions.browser.test.ts', 'utf8')
source = source.replace("import { useDuckDb } from '../../composables/use-duck-db'", `import { mkdtempSync, readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createManualClock } from '../../../src/main/clock'
import { createMemoryDatabaseClient } from '../../../src/main/memory/storage/client'
import { createNativeMemoryDatabase } from '../../../src/main/memory/storage/neo'
import { createMemorySnapshots } from '../../../src/main/memory/storage/snapshots'`)
for (const name of ['interactions', 'local-memory', 'reconciliation']) source = source.replace(`from './${name}'`, `from '../../../src/main/memory/airi/repository/${name}'`)
source = source.replace('const database = useDuckDb()', `const root = mkdtempSync(join(resolve('test-results'), 'memory-native-upstream-'))
const clock = createManualClock(1_790_000_000_000)
let client = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock)
const database = {
  db: { get value() { return client } },
  transaction: <T>(action: Parameters<typeof client.transaction<T>>[0]) => client.transaction(action),
  getDb: async () => { client = createMemoryDatabaseClient(createNativeMemoryDatabase(), clock); await client.open(join(root, 'facts.duckdb')) },
  closeDb: () => client.close(), checkpointDb: () => client.checkpoint(),
  exportSnapshot: () => createMemorySnapshots(client, root).exportSnapshot(),
  importSnapshot: (entries: Parameters<ReturnType<typeof createMemorySnapshots>['importSnapshot']>[0]) => createMemorySnapshots(client, root).importSnapshot(entries),
}`)
source = source.replace(/ {2}const url = new URL\(location.href\)[\s\S]*? {2}await database.getDb\(\)/, '  await database.getDb()')
const start = source.indexOf('    const client = await database.db.value!.$client')
const end = source.indexOf('    await clear()', start)
if (start < 0 || end < 0) throw new Error('UPSTREAM_FIXTURE_CHANGED')
source = source.slice(0, start) + `    const file = join(root, 'legacy-memory-test.parquet')
    try {
      await client.execute("COPY (SELECT * EXCLUDE(title, summary, revision, summary_revision, pinned, pin_order) FROM memory_fragments) TO '" + file.replaceAll("'", "''") + "' (FORMAT PARQUET)")
      old.find(entry => entry.path === 'memory/memory_fragments.parquet')!.data = new Uint8Array(readFileSync(file))
    } finally { unlinkSync(file) }
` + source.slice(end)
writeFileSync(target, '// AIRI MIT original interaction assertions; native owner/snapshot IO adapter.\n' + source)

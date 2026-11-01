// Reproducible initial host extraction. Subsequent edits belong in the LCA sources.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const root = resolve('vendor/airi-memory')
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const selected = new Map(manifest.files.map(file => [file.path, file]))
const runtimeRoot = resolve('src/main/memory/airi')
if (existsSync(runtimeRoot)) throw new Error('Host sources already extracted; refusing to overwrite edits.')
const read = path => {
  const file = selected.get(path)
  return readFileSync(resolve(root, file.layer, path), 'utf8').replaceAll('\r\n', '\n')
}
const header = path => `// Adapted from AIRI (MIT). Pinned source and modifications: vendor/airi-memory/README.md\n// Upstream: ${path}\n`
const mapping = new Map()
for (const path of selected.keys()) {
  if (path.startsWith('packages/memory-core/src/')) mapping.set(path, `core/${path.split('/').at(-1)}`)
  if (path.startsWith('packages/memory-pgvector/src/') && !path.endsWith('/index.ts')) mapping.set(path, `pgvector/${path.split('/').at(-1)}`)
  if (/services\/memory\/(local-memory|interaction-repository|interactions|reconciliation|write-access)(\.test)?\.ts$/.test(path)) mapping.set(path, `repository/${path.split('/').at(-1)}`)
}
for (const [path, target] of mapping) {
  const test = target.endsWith('.test.ts')
  const dest = resolve(test ? 'tests/unit/airi' : runtimeRoot, target)
  let source = read(path).replaceAll("'@proj-airi/memory-core'", "'../core/index'")
  if (path.endsWith('/local-memory.ts')) {
    source = source.replace(/^import type .* from '@proj-airi\/core-agent'\n/m, '')
    source = source.slice(0, source.indexOf('export interface PersistedPlanRecord')) + source.slice(source.indexOf('/**', source.indexOf('function createId()')))
    source = source.replace('runTransaction?: MemoryDbTransaction): DuckDbMemoryRepository', "runTransaction?: MemoryDbTransaction, clock: Pick<Clock, 'nowMs'> = systemClock): MemoryInteractionRepository")
    const start = source.indexOf('  async function savePlan(')
    source = source.slice(0, start) + source.slice(source.indexOf('  async function get(', start))
    source = source.replaceAll('    savePlan,\n', '').replaceAll('    loadPlans,\n', '').replaceAll('    softDeletePlan,\n', '')
      .replaceAll('createId()', 'randomUUID()').replaceAll('Date.now()', 'clock.nowMs()')
      .replace('createDuckDbMemoryRepository(executor)', 'createDuckDbMemoryRepository(executor, undefined, clock)')
    source = "import { randomUUID } from 'node:crypto'\nimport { systemClock, type Clock } from '../../../clock'\n" + source
  }
  if (path.endsWith('/interactions.ts')) {
    source = "import { systemClock, type Clock } from '../../../clock'\n" + source
    source = source.replace('proposal: MemoryProposal): Promise<MemoryOperation>', "proposal: MemoryProposal, clock: Pick<Clock, 'nowMs'> = systemClock): Promise<MemoryOperation>")
      .replace('isCurrent: () => boolean): Promise<MemoryOperation>', "isCurrent: () => boolean, clock: Pick<Clock, 'nowMs'> = systemClock): Promise<MemoryOperation>")
      .replaceAll('Date.now()', 'clock.nowMs()')
  }
  if (path.endsWith('/memory-pgvector/src/repository.ts')) {
    source = "import { systemClock, type Clock } from '../../../clock'\n" + source
    source = source.replace('createMemoryRepository(db: MemoryDatabase)', "createMemoryRepository(db: MemoryDatabase, clock: Pick<Clock, 'nowMs'> = systemClock)")
      .replaceAll('Date.now()', 'clock.nowMs()')
  }
  if (path.endsWith('/local-memory.test.ts')) {
    const start = source.indexOf("  it('saves, loads, and soft-deletes plan snapshots by id'")
    source = source.slice(0, start) + source.slice(source.indexOf("  it('restores source-turn neighbors", start))
  }
  if (test) {
    source = source.replace(/(from\s+|import\()['"](\.[^'"]+)['"]/g, (_, prefix, dep) => {
      let rewritten = relative(dirname(dest), resolve(dirname(resolve(runtimeRoot, target)), dep)).replaceAll('\\', '/')
      if (!rewritten.startsWith('.')) rewritten = './' + rewritten
      return `${prefix}'${rewritten}'`
    })
  }
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, header(path) + source)
}
// Keep the original SQL statements, including legacy columns/table compatibility.
const schemaSource = read('packages/stage-ui/src/composables/use-duck-db.ts')
const start = schemaSource.indexOf('        await dbInstance.execute(`')
const end = schemaSource.indexOf('        db.value = dbInstance', start)
const schema = schemaSource.slice(start, end).replace(/^ {8}/gm, '  ').replaceAll('dbInstance.execute', 'db.execute')
writeFileSync(resolve(runtimeRoot, 'schema.ts'), header('packages/stage-ui/src/composables/use-duck-db.ts') +
  "import type { MemoryDbExecutor } from './repository/interaction-repository'\n\nexport async function initializeMemorySchema(db: MemoryDbExecutor): Promise<void> {\n" + schema + '}\n')
console.log(JSON.stringify({ extracted: mapping.size + 1, excludedTest: 'AIRI PlanPersistenceRepository is outside the memory migration; original test remains pinned.' }))

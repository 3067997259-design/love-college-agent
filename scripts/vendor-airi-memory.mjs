// One-time, explicit source import. Runtime never loads the reference checkout.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const commit = '3a84a4fbaf6a54defe385e050be86fcb5436745b'
const reference = process.argv[2]
if (!reference) throw new Error('Usage: node scripts/vendor-airi-memory.mjs <read-only AIRI checkout>')
const destination = resolve('vendor/airi-memory')
const extendTests = process.argv.includes('--extend-tests')
if (existsSync(resolve(destination, 'manifest.json')) && !extendTests) throw new Error('Pinned source already exists; do not overwrite it.')
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${resolve(reference).replaceAll('\\', '/')}`, '-C', reference, ...args], { maxBuffer: 16 * 1024 * 1024 })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const roots = ['packages/memory-core/src', 'packages/memory-pgvector/src', 'packages/stage-ui/src/services/memory']
const extra = ['LICENSE', 'packages/stage-ui/src/stores/modules/memory.ts', 'packages/stage-ui/src/composables/use-duck-db.ts']
const baselinePaths = [...new Set([...git('ls-tree', '-r', '--name-only', commit, ...roots).toString().trim().split('\n'), ...extra])]
// Only reviewed memory directory/interaction/reconciliation and recovery changes.
// AIRI's chat ownership repair is a host concern; no other feature or UI is imported.
const increments = [
  'packages/memory-core/src/index.ts', 'packages/memory-core/src/types.ts',
  'packages/memory-core/src/interaction.ts', 'packages/memory-core/src/interaction.test.ts',
  'packages/memory-pgvector/src/repository.ts', 'packages/memory-pgvector/src/schema.ts',
  'packages/stage-ui/src/services/memory/local-memory.ts',
  'packages/stage-ui/src/services/memory/interaction-repository.ts',
  'packages/stage-ui/src/services/memory/interactions.ts',
  'packages/stage-ui/src/services/memory/interactions.browser.test.ts',
  'packages/stage-ui/src/services/memory/reconciliation.ts',
  'packages/stage-ui/src/services/memory/reconciliation.test.ts',
  'packages/stage-ui/src/stores/modules/memory.ts',
  'packages/stage-ui/src/composables/use-duck-db.ts',
]
const priorManifest = extendTests ? JSON.parse(readFileSync(resolve(destination, 'manifest.json'), 'utf8')) : undefined
const files = priorManifest?.files ?? []
function save(layer, path, bytes) {
  const target = resolve(destination, layer, path)
  if (existsSync(target)) throw new Error(`Refusing to overwrite pinned file: ${target}`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  files.push({ layer, path, sha256: hash(bytes), bytes: bytes.length })
}
const reviewed = JSON.parse(readFileSync('docs/research/evidence/airi-memory-direct-reuse-20261101.json', 'utf8'))
const extraTests = ['packages/stage-ui/src/stores/modules/memory.test.ts', 'packages/stage-ui/src/stores/modules/memory-embedding.browser.test.ts', 'packages/stage-ui/src/stores/modules/memory-settings.browser.test.ts']
for (const path of extendTests ? [extraTests[0]] : baselinePaths) {
  const bytes = git('show', `${commit}:${path}`)
  const prior = reviewed.sources.find(item => item.path === path)
  if (prior && prior.sha256 !== hash(bytes)) throw new Error(`Reviewed baseline mismatch: ${path}`)
  save('baseline', path, bytes)
}
for (const path of extendTests ? extraTests : increments) save('increment', path, readFileSync(resolve(reference, path)))
writeFileSync(resolve(destination, 'manifest.json'), JSON.stringify({
  schema: 1, upstream: 'https://github.com/moeru-ai/airi', commit,
  selection: 'fixed mods plus memory directory, interaction, reconciliation and V3 host recovery increment',
  files,
}, null, 2) + '\n')
console.log(JSON.stringify({ commit, baseline: baselinePaths.length, increment: increments.length, files: files.length }))

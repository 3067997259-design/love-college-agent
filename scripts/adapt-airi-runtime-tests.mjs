import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

const target = 'tests/unit/airi/runtime-upstream.test.ts'
if (existsSync(target)) throw new Error('Refusing to overwrite adapted tests')
let source = readFileSync('vendor/airi-memory/increment/packages/stage-ui/src/stores/modules/memory.test.ts', 'utf8').replaceAll('\r\n', '\n')
source = source.replace('// @vitest-environment jsdom\n', '// AIRI original orchestration assertions; only Pinia/browser/IO fixtures are replaced.\n')
source = source.replace("import { createPinia, setActivePinia } from 'pinia'\n", '')
source = source.replace(/^import .* from '(?:\.\.\/\.\.\/services\/restore-gate|\.\.\/journal|\.\/memory)'\n/gm, '')
const ast = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true)
const mocks = ast.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'vi.mock')
for (const node of mocks.reverse()) source = source.slice(0, node.getFullStart()) + source.slice(node.end)
source = source.replace('  completeRestoreGate()\n', '').replace('  setActivePinia(createPinia())\n', '  activeStore = undefined\n  journalEvents.clear()\n')
source = source.replace("  vi.stubGlobal('location', new URL('http://localhost/?synced-leader=true'))\n", '')
const setup = `
// Host fixtures implement the upstream IO seams; no provider or private profile is used.
const storage = new Map<string, string>()
const listeners = new Set<(key: string) => void>()
const localStorage = {
  clear() { storage.clear(); listeners.clear() },
  getItem(key: string) { return storage.get(key) ?? null },
  setItem(key: string, value: string) { storage.set(key, value); for (const listener of listeners) listener(key) },
}
const journalEvents = new Map<string, Record<string, unknown>[]>()
const useJournalStore = () => ({
  append(id: string, event: Record<string, unknown>) { journalEvents.set(id, [...journalEvents.get(id) ?? [], event]) },
  readSession(id: string) { return journalEvents.get(id) ?? [] },
})
let dreamAgent: MemoryDreamAgent | undefined
let mirror: MemoryHostPort | undefined
const installMemoryDreamAgent = (next: MemoryDreamAgent | undefined) => { dreamAgent = next }
const installMemoryHostPort = (next: MemoryHostPort | undefined) => { mirror = next }
type Unwrapped<T> = { [K in keyof T]: T[K] extends { value: infer V } ? V : T[K] }
let activeStore: Unwrapped<ReturnType<typeof createAiriMemoryRuntime>> | undefined
function useMemoryStore() {
  if (activeStore) return activeStore
  const state: MemoryRuntimeState = {
    cell: <T>(key: string, fallback: T) => ({
      get value(): T {
        const value = localStorage.getItem(key)
        // Original tests exercise the original default switches.
        if (value === null && /directory-enabled|tools-enabled/.test(key)) return false as T
        return value === null ? fallback : typeof fallback === 'string' ? value as T : JSON.parse(value) as T
      },
      set value(value: T) { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)) },
      reset() { this.value = structuredClone(fallback) },
    }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    reload() { for (const listener of listeners) listener('*') },
  }
  const runtime = createAiriMemoryRuntime({
    clock: systemClock, state, scope: () => dreamScope, isOwner: () => true,
    effectsHeld: () => false, waitForRestore: async () => {},
    openDatabase: async () => {
      await database.getDb()
      const db = createMemoryDatabaseClient({ request: async () => null }, systemClock)
      await db.open('synthetic')
      return db
    },
    repository: () => repository as unknown as MemoryInteractionRepository,
    embedding: {
      configure: async () => {
        if (localStorage.getItem('settings/memory/embedding-source') !== 'api') { installMemoryEmbeddingSource(undefined); return true }
        const baseUrl = localStorage.getItem('settings/memory/embedding-base-url') ?? ''
        const apiKey = localStorage.getItem('settings/memory/embedding-api-key') ?? ''
        if (!baseUrl || !apiKey) { installMemoryEmbeddingSource(undefined); throw new Error('Embedding base URL and API key are required') }
        installMemoryEmbeddingSource(createApiMemoryEmbeddingSource({ baseUrl, apiKey, model: localStorage.getItem('settings/memory/embedding-model') ?? 'text-embedding-3-small' }))
        return true
      },
      embedMemoryText, activeMemoryEmbeddingMetadata, activeMemoryEmbeddingFingerprint, activeMemoryEmbeddingUsage,
    } as MemoryEmbeddingRuntime,
    get dreamAgent() { return dreamAgent }, get mirror() { return mirror },
    journal: (id, event) => useJournalStore().append(id, event),
  })
  activeStore = new Proxy(runtime, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      return value && typeof value === 'object' && 'value' in value ? value.value : value
    },
    set(target, key, value) {
      const cell: unknown = Reflect.get(target, key)
      if (cell && typeof cell === 'object' && 'value' in cell) { cell.value = value; return true }
      return Reflect.set(target, key, value)
    },
  }) as unknown as Unwrapped<typeof runtime>
  return activeStore
}
`
source = source.replace('beforeEach(() => {', setup + '\nbeforeEach(() => {')
source = `import { systemClock } from '../../../src/main/clock'
import { createMemoryDatabaseClient } from '../../../src/main/memory/storage/client'
import type { MemoryRuntimeState } from '../../../src/main/memory/storage/state'
import type { MemoryInteractionRepository } from '../../../src/main/memory/airi/repository/interaction-repository'
import type { MemoryEmbeddingRuntime } from '../../../src/main/memory/airi/host-ports'
import { createAiriMemoryRuntime, MEMORY_BROWSER_SESSION_ID, type MemoryDreamAgent, type MemoryHostPort } from '../../../src/main/memory/airi/runtime'
` + source
writeFileSync(target, source)

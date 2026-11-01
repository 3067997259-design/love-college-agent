import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

const target = 'src/main/memory/airi/runtime.ts'
if (existsSync(target)) throw new Error('Refusing to overwrite runtime edits')
let source = readFileSync('vendor/airi-memory/increment/packages/stage-ui/src/stores/modules/memory.ts', 'utf8').replaceAll('\r\n', '\n')
source = source.replaceAll("'@proj-airi/memory-core'", "'./core'")
  .replaceAll('../../services/memory/', './repository/')
  .replace(/^import .* from '(?:@moeru\/std|@proj-airi\/stage-shared\/composables|pinia|vue|\.\/repository\/write-access|\.\.\/\.\.\/services\/restore-gate|\.\.\/auth|\.\.\/journal)'\n/gm, '')
source = source.replace(/let dreamAgent:[\s\S]*?\n}\n/, '')
source = source.replace(/let memoryHostPort:[\s\S]*?\n}\n/, '')
source = source.replace("export const useMemoryStore = defineStore('memory', () => {\n  const authStore = useAuthStore()", `export function createAiriMemoryRuntime(ports: AiriMemoryPorts) {
  const clock = ports.clock
  const state = ports.state
  const setting = <T>(key: string, fallback: T) => state.cell(key, fallback)
  const authStore = { get userId() { return ports.scope().userId } }
  const memoryHostPort = ports.mirror
  const areRestoreEffectsHeld = ports.effectsHeld
  const waitForRestore = ports.waitForRestore
  let disposed = false`)
source = source.replaceAll('shallowRef', 'memoryCell').replaceAll('computed(', 'memoryComputed(')
source = source.replaceAll('useLocalStorageManualReset', 'setting').replaceAll(', { listenToStorageChanges: false }', '')
source = source.replace("memoryComputed(() => resolveMemoryWriteAccess() === 'leader')", 'memoryComputed(() => !disposed && ports.isOwner())')
source = source.replace("memoryCell(isLeader.value && localStorage.getItem('settings/memory/directory-enabled') === 'true')", "setting('settings/memory/directory-enabled', true)")
source = source.replace("memoryCell(isLeader.value && localStorage.getItem('settings/memory/tools-enabled') === 'true')", "setting('settings/memory/tools-enabled', true)")
source = source.replace(/ {2}onScopeDispose\([\s\S]*?\n {2}}, \{ flush: 'sync' \}\)\n/, `  function revoke() {
    authorityEpoch += 1
    for (const capture of captures) capture.abort(new Error('Memory authority revoked'))
  }
  const unsubscribe = state.subscribe((key) => {
    if (key === '*' || !enabled.value || !captureEnabled.value) revoke()
  })
`)
source = source.replace(/^ {4}localStorage.setItem.*\n/gm, '')
// DSH alone compacts roots; these browser chat settings are not memory algorithms.
const removed = ['compactionEnabled', 'activeProvider', 'activeModel', 'compactionThreshold', 'contextLengthOverride', 'compactionRecentTurnLimit', 'embeddingSource', 'embeddingBaseUrl', 'embeddingApiKey', 'embeddingModel', 'pgConnectionString', 'linkLocalHistory']
for (const name of removed) source = source.replace(new RegExp(`^  const ${name} = .*\\n`, 'm'), '').replaceAll(`    ${name}.reset()\n`, '').replaceAll(`    ${name},\n`, '')
source = source.replace('setting(\'settings/memory/enabled\', false)', 'setting(\'settings/memory/enabled\', true)')
source = source.replace('setting(\'settings/memory/capture-enabled\', false)', 'setting(\'settings/memory/capture-enabled\', true)')
source = source.replace(/ {2}async function applyEmbeddingSource\(\): Promise<boolean> \{[\s\S]*?\n {2}}/, `  async function applyEmbeddingSource(): Promise<boolean> {
    embeddingError.value = undefined
    try { return await ports.embedding.configure() }
    catch { embeddingError.value = 'Memory embedding is unavailable'; return false }
  }`)
source = source.replace(/ {6}const \[\{ useDuckDb \}[\s\S]*?repository\.value = createDuckDbMemoryRepository\(database.db.value, database.transaction\)/, `      const database = await ports.openDatabase()
      databaseControl = {
        checkpointDb: async () => { await database.checkpoint(); return { state: 'complete', pendingWrites: 0, lastCheckpointAt: clock.nowMs() } },
        closeDb: () => database.close(),
      }
      repository.value = ports.repository?.(database) ?? createDuckDbMemoryRepository(database, database.transaction, clock)`)
source = source.replaceAll("await import('./repository/local-memory-embedding')", 'ports.embedding')
source = source.replace(/ {2}function linkedUserIdsForScope\(scope: MemoryScope\): string\[\] \{[\s\S]*?\n {2}}/, `  function linkedUserIdsForScope(scope: MemoryScope): string[] { return ports.linkedUserIds?.(scope) ?? [] }`)
source = source.replace("await import('./repository/evaluate-chinese-memory')", "await import('./evaluation')")
source = source.replace(/ {4}const stop = watch\(canCapture,[\s\S]*?\n {4}}, \{ flush: 'sync' \}\)\n/, '')
source = source.replaceAll('      stop()\n', '')
source = source.replaceAll('useJournalStore().append(', 'ports.journal(')
source = source.replace('dreamAgent ? await dreamAgent(', 'ports.dreamAgent ? await ports.dreamAgent(')
source = source.replace(/ {2}function localDreamDayKey\(timestamp: number\): string \{[\s\S]*?\n {2}}/, `  function localDreamDayKey(timestamp: number): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp)
  }`)
source = source.replace(/ {2}function restorePersistedSettings\(\): void \{[\s\S]*?\n {2}}/, '  function restorePersistedSettings(): void { revoke(); state.reload() }')
source = source.replace(/ {2}\/\/ Expiry scheduler[\s\S]*?\n {2}function resetState\(\)/, `  /** Called by LCA Scheduler; owns no browser timers or provider loop. */
  async function maintenance(): Promise<void> {
    if (disposed || ports.effectsHeld()) return
    await flushLongTermSyncOutbox(ports.embedding.embedMemoryText)
  }

  async function refreshEmbedding(): Promise<void> {
    backgroundVectorsReady = false
    const ready = await applyEmbeddingSource()
    if (repository.value && ready) await migrateEmbeddingSpace(repository.value, true)
  }

  async function dispose(): Promise<void> {
    disposed = true; revoke(); unsubscribe()
    await syncFlush
    await databaseControl?.closeDb?.()
  }

  function resetState()`)
source = source.replace(/ {4}if \(isLeader.value\) \{\n {6}localStorage.removeItem[\s\S]*?\n {4}}/, '')
source = source.replace('    pgConnectionString.value = connectionString\n', '')
source = source.replaceAll('Date.now()', 'clock.nowMs()').replaceAll('ReturnType<typeof setTimeout>', '(() => void)')
source = source.replaceAll('clearTimeout(timeout)', 'timeout?.()').replaceAll('clearTimeout(deadline)', 'deadline()')
source = source.replaceAll('await proposeMemoryOperation(memoryRepository, context, operationId, proposal)', 'await proposeMemoryOperation(memoryRepository, context, operationId, proposal, clock)')
source = source.replaceAll('await reviewMemoryOperation(memoryRepository, scope, operationId, approve, isCurrent)', 'await reviewMemoryOperation(memoryRepository, scope, operationId, approve, isCurrent, clock)')
source = source.replace(/^ {6}console.warn.*\n/gm, '')
source = source.slice(0, source.indexOf('\n}, {\n  synced:')) + '\n}\n'
source = source.replace('    resetState,\n', '    resetState,\n    maintenance,\n    refreshEmbedding,\n    revoke,\n    dispose,\n')
// Preserve each upstream timeout expression, changing only the clock call convention.
const ast = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true)
const replacements = []
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'setTimeout') {
    replacements.push({ start: node.getStart(ast), end: node.end, text: `clock.after(${node.arguments[1].getText(ast)}, ${node.arguments[0].getText(ast)})` })
  }
  ts.forEachChild(node, visit)
}
visit(ast)
for (const patch of replacements.sort((a, b) => b.start - a.start)) source = source.slice(0, patch.start) + patch.text + source.slice(patch.end)
source = `// AIRI mods + audited memory increment, MIT. See vendor/airi-memory/README.md.
// Domain orchestration is preserved; LCA supplies ownership, persistence and IO.
import type { AiriMemoryPorts } from './host-ports'
import { memoryCell, memoryComputed } from '../storage/state'
import { createDuckDbMemoryRepository } from './repository/local-memory'
const errorMessageFrom = (error: unknown) => error instanceof Error ? error.message : String(error)
` + source
writeFileSync(target, source)
// Production evaluation remains the upstream 90-case loop; embedding is injected.
let evaluation = readFileSync('vendor/airi-memory/baseline/packages/stage-ui/src/services/memory/evaluate-chinese-memory.ts', 'utf8').replaceAll('\r\n', '\n')
evaluation = evaluation.replaceAll("'@proj-airi/memory-core'", "'./core'").replace("import { embedMemoryText } from './local-memory-embedding'\n", '')
evaluation = evaluation.replace('texts: Readonly<Record<string, string>>)', 'texts: Readonly<Record<string, string>>, embedMemoryText: (text: string) => Promise<number[]>)')
writeFileSync('src/main/memory/airi/evaluation.ts', '// AIRI MIT; see vendor/airi-memory/README.md. Only the embedding IO is injected.\n' + evaluation)

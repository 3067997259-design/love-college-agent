import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createArtifactStore } from '../../src/main/artifacts/store'
import { createScheduler } from '../../src/main/scheduler'
import { projectMemory } from '../../src/main/memory/projection'
import { createQuillService } from '../../src/main/gifts/quill'
import type { SessionStore } from '../../src/main/store/session'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lca-quill-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-quill-'))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) })
  const clock = createManualClock(1000); const journal = openJournal(root, { userId: 'user', characterId: 'character' }, clock)
  const store: SessionStore = { scope: journal.scope, records: journal.records, append: journal.append, projection: () => projectJournal(journal.records()), close: journal.close }
  const scheduler = createScheduler(clock); const artifacts = createArtifactStore(root, store.scope)
  const memory = { view: () => projectMemory(journal.records()), append: journal.append, refresh: () => {}, close: () => {} }
  let busy = false; let emitted = ''
  const quill = createQuillService({ clock, store, scheduler, artifacts, memory, isBusy: () => busy, changed: () => {}, emit: (source, text, id) => { emitted = text; journal.append({ type: 'inbox/event', id, source, text }) } })
  scheduler.cancel('quill.first-gift'); cleanups.push(() => { quill.dispose(); scheduler.dispose(); journal.close() })
  const artifact = artifacts.write({ candidateId: 'doc:' + 'a'.repeat(64), revision: 1, format: 'md', displayName: '整理-aaaaaaaa.md', source: 'fake', kind: 'document', createdAtMs: 1000, content: 'USER_ONLY_RESULT' })
  const complete = () => journal.append({ type: 'document/completed', documentId: 'doc:' + 'a'.repeat(64), attempt: 1, artifact, facts: { documentId: 'doc:' + 'a'.repeat(64), fileName: '整理-aaaaaaaa.md', format: 'text', pageCount: null, deadlineIso: null, source: 'fake', trust: 'untrusted' } })
  const seen = () => journal.append({ type: 'model/seen', turnId: 't', source: 'fake', messages: [{ role: 'user', content: JSON.stringify({ source: 'document', facts: emitted }) }], eligibleIndexes: [0] })
  return { root, journal, quill, memory, artifact, complete, seen, setBusy: (value: boolean) => { busy = value } }
}
describe('first quill gift grounded in completed, then-seen work', () => {
  it('waits for actual artifact evidence and a successful visible frame, then gives only once at rest', () => {
    const f = fixture(); f.quill.reconcile(); expect(f.quill.read()).toBeUndefined(); f.complete(); f.quill.reconcile(); expect(f.quill.read()).toBeUndefined()
    f.journal.append({ type: 'companion/mode', mode: 'quiet', requestId: 'quiet', commandHash: 'test' }); f.seen(); f.quill.reconcile()
    expect(f.quill.read()?.state).toBe('ready'); expect(f.memory.view().items[0].text).toBe('已生成资料整理文件'); expect(f.memory.view().items[0].sources[0].frameSeq).toBeGreaterThan(1)
    expect(JSON.stringify(f.memory.view())).not.toContain('USER_ONLY_RESULT')
    f.journal.append({ type: 'companion/mode', mode: 'rest', requestId: 'rest', commandHash: 'test' }); f.setBusy(true); f.quill.reconcile(); expect(f.quill.read()?.state).toBe('ready')
    f.setBusy(false); f.quill.reconcile(); f.quill.reconcile(); expect(f.quill.read()?.state).toBe('given')
    expect(f.journal.records().filter((row) => row.type === 'quill/given')).toHaveLength(1)
  })
  it('does not give a gift for a tampered artifact or while lights are out', () => {
    const f = fixture(); f.complete(); writeFileSync(join(f.root, f.artifact.relativePath), 'tampered'); f.quill.reconcile(); expect(f.quill.read()).toBeUndefined()
    writeFileSync(join(f.root, f.artifact.relativePath), 'USER_ONLY_RESULT'); f.quill.reconcile(); f.seen()
    f.journal.append({ type: 'companion/lights', lightsOut: true, requestId: 'dark', commandHash: 'test' }); f.quill.reconcile(); expect(f.quill.read()).toBeUndefined()
    f.journal.append({ type: 'companion/lights', lightsOut: false, requestId: 'light', commandHash: 'test' }); f.quill.reconcile(); expect(f.quill.read()?.state).toBe('given')
  })
  it('re-enqueues an unseen completion fact if stopping a turn dropped its pending event', () => {
    const f = fixture(); f.complete(); f.quill.reconcile()
    const first = f.journal.records().find((row) => row.type === 'inbox/event')!
    if (first.type !== 'inbox/event') throw new Error('Fixture event missing')
    f.journal.append({ type: 'inbox/drop', ids: [first.id] }); f.quill.reconcile()
    expect(f.journal.records().filter((row) => row.type === 'inbox/event')).toHaveLength(2)
    f.seen(); f.quill.reconcile(); expect(f.quill.read()?.state).toBe('given')
  })
})

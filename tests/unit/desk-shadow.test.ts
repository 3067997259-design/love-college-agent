import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { openJournal } from '../../src/main/journal/file'
import { projectJournal } from '../../src/main/journal/projection'
import { createDesk } from '../../src/main/heart-flow/desk'
import { createDeskShadow } from '../../src/main/heart-flow/shadow'
import { createHeartFlow } from '../../src/main/heart-flow/service'
import type { SessionStore } from '../../src/main/store/session'
import type { AppCommand } from '../../src/shared'
const cleanups: (() => void)[] = []; afterEach(() => cleanups.splice(0).reverse().forEach((fn) => fn()))
function git(args: string[], input?: string) { const result = spawnSync('git', args, { input, windowsHide: true }); if (result.status !== 0) throw new Error('TEST_GIT_FAILED'); return result.stdout.toString().trim() }
async function fixture(gitDesk = true, unavailable = false) {
  const root = mkdtempSync(join(tmpdir(), 'lca-shadow-')); cleanups.push(() => { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-shadow-'))) throw new Error('UNSAFE'); rmSync(root, { recursive: true, force: true }) })
  const deskRoot = join(root, 'desk'); const desk = createDesk(deskRoot); if (gitDesk) git(['init', '--quiet', deskRoot])
  const clock = createManualClock(1792184000123); const j = openJournal(root, { userId: 'u', characterId: 'c' }, clock); cleanups.push(j.close)
  const store: SessionStore = { scope: j.scope, records: j.records, append: j.append, projection: () => projectJournal(j.records()), close: j.close }
  const shadowRoot = join(root, 'private-shadow'); const options = { root: shadowRoot, deskRoot, store, unavailable }; const shadow = createDeskShadow(options)
  const opts = { store, clock, desk, shadow, booth: false, busy: () => false, changed: () => {}, prepare: async () => ({ messages: [], eligibleIndexes: [] }), emit: vi.fn(), inspect: vi.fn(), run: vi.fn(async () => 'never') }
  const flow = createHeartFlow(opts); cleanups.push(flow.close)
  const send = (body: object) => flow.dispatch(body as AppCommand); send({ type: 'flow.enter' }); await vi.waitFor(() => expect(flow.active()).toBe(true)); send({ type: 'flow.mode', mode: 'execute' })
  return { root, deskRoot, shadowRoot, desk, clock, store, shadow, options, flow, opts, send }
}
it('makes real before/after Git commits for writes, deletions and undo without touching the original Git index/config/hooks/refs', async () => {
  const f = await fixture(); const originalHead = readFileSync(join(f.deskRoot, '.git', 'HEAD')); const originalConfig = readFileSync(join(f.deskRoot, '.git', 'config'))
  const hook = join(f.root, 'HOOK_MUST_NOT_RUN'); writeFileSync(join(f.deskRoot, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho BAD > "' + hook.replaceAll('\\', '/') + '"\n')
  f.desk.write('目录/资料,引号.md', 'ORIGINAL_PRIVATE_VERSION'); const id = f.flow.write('目录/资料,引号.md', 'APPLIED_PRIVATE_VERSION')
  const receipt = f.shadow.view(id)!; expect(receipt.status).toBe('committed'); const repo = '--git-dir=' + join(f.shadowRoot, 'repository.git')
  expect(git([repo, 'show', receipt.commit + ':目录/资料,引号.md'])).toBe('APPLIED_PRIVATE_VERSION')
  expect(git([repo, 'show', receipt.commit + '^:目录/资料,引号.md'])).toBe('ORIGINAL_PRIVATE_VERSION')
  expect(f.flow.inspect({ section: 'diff' }).changes[0].shadow).toEqual(receipt)
  f.send({ type: 'flow.inspect', section: 'diff' }); expect(f.opts.inspect.mock.calls[0][0].changes[0].shadow).toEqual(receipt)
  expect(f.send({ type: 'flow.undo', changeId: id })).toBeUndefined(); expect(f.desk.read('目录/资料,引号.md')).toBe('ORIGINAL_PRIVATE_VERSION')
  const deleted = f.flow.write('目录/资料,引号.md', null); const deletion = f.shadow.view(deleted)!
  expect(git([repo, 'ls-tree', '-r', deletion.commit!])).toBe(''); expect(git([repo, 'show', deletion.commit + '^:目录/资料,引号.md'])).toBe('ORIGINAL_PRIVATE_VERSION')
  expect(readFileSync(join(f.deskRoot, '.git', 'HEAD'))).toEqual(originalHead); expect(readFileSync(join(f.deskRoot, '.git', 'config'))).toEqual(originalConfig)
  expect(existsSync(join(f.deskRoot, '.git', 'index'))).toBe(false); expect(existsSync(hook)).toBe(false)
  expect(JSON.stringify(f.store.records().filter((r) => r.type === 'desk/shadow'))).not.toContain('PRIVATE_VERSION')
})
it('recreates identical private shadow objects from archive journal snapshots and original times', async () => {
  const f = await fixture(); const id = f.flow.write('source.md', 'CONTENT'); const first = f.shadow.view(id)
  const target = resolve(f.shadowRoot); if (!target.startsWith(resolve(f.root) + sep)) throw new Error('UNSAFE'); rmSync(target, { recursive: true, force: true })
  f.clock.advanceBy(86400000); const restored = createDeskShadow(f.options); expect(restored.view(id)).toEqual(first)
  const ref = 'refs/lca/' + createHash('sha256').update(id).digest('hex')
  expect(git(['--git-dir=' + join(f.shadowRoot, 'repository.git'), 'rev-parse', ref])).toBe(first!.commit)
  expect(git(['--git-dir=' + join(f.shadowRoot, 'repository.git'), 'show', first!.commit + ':source.md'])).toBe('CONTENT')
})
it.each([false, true])('falls back to journal snapshots with explicit status (Git unavailable=%s)', async (unavailable) => {
  const f = await fixture(unavailable, unavailable); const id = f.flow.write('product.md', 'ACTUAL_PRODUCT')
  expect(f.shadow.view(id)?.status).toBe(unavailable ? 'unavailable' : 'not-git'); expect(f.desk.read('product.md')).toBe('ACTUAL_PRODUCT')
  expect(f.send({ type: 'flow.undo', changeId: id })).toBeUndefined(); expect(f.desk.read('product.md')).toBeNull()
})
it('refuses redirected Git markers and private shadow ancestors without overwriting the applied desk file', async () => {
  const f = await fixture(false); const outside = join(f.root, 'outside'); createDesk(outside)
  symlinkSync(outside, join(f.deskRoot, '.git'), 'junction'); const id = f.flow.write('safe.md', 'SAFE'); expect(f.shadow.view(id)?.status).toBe('unavailable')
  const g = await fixture(); symlinkSync(outside, g.shadowRoot, 'junction'); const other = g.flow.write('safe.md', 'SAFE')
  expect(g.shadow.view(other)?.status).toBe('failed'); expect(g.desk.read('safe.md')).toBe('SAFE'); expect(existsSync(join(outside, 'repository.git'))).toBe(false)
  expect(g.shadow.view(randomUUID())).toBeUndefined()
})

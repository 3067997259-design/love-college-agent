import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSkills } from '../../src/main/dsh/skills'
import type { ExtensionRuntime } from '../../src/main/dsh/extensions'
import { createManualClock } from '../../src/main/clock'
import type { AppCommand } from '../../src/shared'
import type { DshExtensionReply } from '../../src/shared/dsh-extensions'
const command = (body: Record<string, unknown>) => ({ protocolVersion: 1, epoch: 'test', requestId: randomUUID(), ...body }) as AppCommand
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const deferred = () => { let done!: (value: boolean) => void; const promise = new Promise<boolean>((resolve) => { done = resolve }); return { promise, done } }
function fixture(approve: () => Promise<boolean> = async () => true) {
  const root = mkdtempSync(join(tmpdir(), 'lca-skills-unit-')), dataDir = join(root, 'data'), source = join(root, 'source'), project = join(root, 'project')
  for (const path of [dataDir, source, project]) mkdirSync(path)
  writeFileSync(join(source, 'SKILL.md'), '---\nname: unit-skill\ndescription: Synthetic\n---\nSYNTHETIC_BODY')
  let cwd = project
  const host: ExtensionRuntime['host'] = { extensions: async (input): Promise<DshExtensionReply> => {
    if (input.action === 'skill-inspect') return { items: [], skills: { complete: true, items: [{ id: 'inspected', name: 'unit-skill', description: 'Synthetic', source: 'profile', sourceLabel: '此存档', status: 'available', modelInvocable: true, userInvocable: true, fingerprint: '' }] } }
    const rows: NonNullable<DshExtensionReply['skills']>['items'] = []
    for (const [dir, scope] of [[join(dataDir, 'dsh-home', 'skills'), 'profile'], [join(cwd, '.dsh', 'skills'), 'project-dsh']] as const) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        const path = join(dir, name, 'SKILL.md')
        rows.push({ id: hash(path), name, description: 'Synthetic', source: scope, sourceLabel: scope, status: 'available', modelInvocable: true, userInvocable: true, fingerprint: hash(readFileSync(path, 'utf8')), path })
      }
    }
    return { items: [], skills: { complete: true, items: rows } }
  } }
  const options = { dataDir, clock: createManualClock(), project: () => cwd, choose: async () => source, blocked: () => false,
    withRuntime: async <T>(job: (runtime: ExtensionRuntime) => Promise<T>) => job({ host, restart: async () => host }), approve, changed: () => {} }
  const service = createSkills(options)
  const run = async (body: Record<string, unknown>) => { expect(service.dispatch(command(body))).toBeUndefined(); await service.idle() }
  const remove = () => { const view = service.view(), row = view.items[0]; return command({ type: 'skills.remove', skillId: row.id, fingerprint: row.fingerprint, projectKey: view.projectKey }) }
  return { root, dataDir, source, project, options, service, run, remove, changeProject: (next: string) => { cwd = next } }
}

it('imports only after approval, records private ownership, recovers and archives only exact imported files', async () => {
  const f = fixture(); await f.run({ type: 'skills.import', scope: 'profile' })
  expect(f.service.view().operation?.outcome).toBe('succeeded'); expect(f.service.view().items[0].removable).toBe(true)
  expect(JSON.stringify(f.service.view())).not.toContain(f.dataDir); expect(JSON.stringify(f.service.view())).not.toContain('SYNTHETIC_BODY')
  f.service.close(); const cold = createSkills(f.options)
  cold.dispatch(command({ type: 'skills.refresh' })); await cold.idle(); expect(cold.view().items[0].removable).toBe(true)
  const view = cold.view(), row = view.items[0]
  cold.dispatch(command({ type: 'skills.remove', skillId: row.id, fingerprint: row.fingerprint, projectKey: view.projectKey })); await cold.idle()
  expect(cold.view().items).toEqual([])
  const archives = join(f.dataDir, 'dsh-home', 'lca-skill-removed')
  expect(readFileSync(join(archives, readdirSync(archives)[0], 'SKILL.md'), 'utf8')).toContain('SYNTHETIC_BODY')
})

it('late allow cannot import after cancellation or project switch', async () => {
  for (const mode of ['cancel', 'switch', 'close']) {
    const answer = deferred(), f = fixture(() => answer.promise)
    f.service.dispatch(command({ type: 'skills.import', scope: 'project' }))
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(f.service.view().operation?.phase).toBe('awaiting-approval')
    if (mode === 'cancel') f.service.dispatch(command({ type: 'skills.cancel', operationId: f.service.view().operation!.id }))
    else if (mode === 'switch') f.changeProject(join(f.root, 'other'))
    else f.service.close()
    answer.done(true); await f.service.idle()
    expect(existsSync(join(f.project, '.dsh', 'skills', 'unit-skill'))).toBe(false)
  }
})

it('never overwrites a same-name directory and refuses changed imported content', async () => {
  const f = fixture(); await f.run({ type: 'skills.import', scope: 'project' })
  await f.run({ type: 'skills.import', scope: 'project' }); expect(f.service.view().operation?.outcome).toBe('failed')
  const oldRemoval = f.remove()
  writeFileSync(join(f.project, '.dsh', 'skills', 'unit-skill', 'notes.txt'), 'USER_EDIT')
  f.service.dispatch(oldRemoval); await f.service.idle()
  expect(f.service.view().operation?.outcome).toBe('failed')
  expect(existsSync(join(f.project, '.dsh', 'skills', 'unit-skill', 'notes.txt'))).toBe(true)
  await f.run({ type: 'skills.refresh' }); expect(f.service.view().items[0].removable).toBe(false)
})

it('does not cross a project skill junction or expose previous project rows', async () => {
  const f = fixture(); mkdirSync(join(f.project, '.dsh'))
  const outside = join(f.root, 'outside'); mkdirSync(outside)
  symlinkSync(outside, join(f.project, '.dsh', 'skills'), 'junction')
  await f.run({ type: 'skills.import', scope: 'project' })
  expect(f.service.view().operation?.outcome).toBe('failed'); expect(readdirSync(outside)).toEqual([])
  await f.run({ type: 'skills.import', scope: 'profile' })
  const stale = f.remove(); f.changeProject(join(f.root, 'another'))
  expect(f.service.view().items).toEqual([]); expect(f.service.dispatch(stale)).toBe('stale-candidate')
})

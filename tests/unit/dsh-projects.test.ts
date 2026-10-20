import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSettings } from '../../src/main/config/settings'
import { createProjects } from '../../src/main/dsh/projects'
import type { AppCommand } from '../../src/shared'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-projects-'))) throw new Error('Unsafe test cleanup path')
  rmSync(root, { recursive: true, force: true })
} })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lca-projects-')); roots.push(root)
  const data = join(root, 'data'); const desk = join(root, 'room', '书桌'); const code = join(root, 'code', 'site'); const other = join(root, 'code', 'game')
  for (const dir of [data, desk, code, other, join(data, 'journals')]) mkdirSync(dir, { recursive: true })
  const settings = openSettings(data)
  let next: string | null = null
  let busy = false
  const untrust = vi.fn()
  const changed = vi.fn()
  const projects = createProjects({ settings, desk, privateRoots: [join(data, 'journals'), join(data, 'settings.json')], trusted: (path) => resolve(path) === resolve(code), untrust,
    busy: () => busy, choose: async () => next, changed })
  const command = (body: Record<string, unknown>) => ({ protocolVersion: 1, requestId: crypto.randomUUID(), epoch: 'e', ...body }) as AppCommand
  const pick = async (path: string | null) => { next = path; const error = projects.dispatch(command({ type: 'project.pick' })); await vi.waitFor(() => expect(projects.view().status).toBe('idle')); return error }
  return { root, data, desk, code, other, settings, projects, command, pick, untrust, changed, setBusy: (value: boolean) => { busy = value } }
}

describe('DSH work projects', () => {
  it('starts at her desk and switches to a folder picked through the dialog', async () => {
    const f = setup()
    expect(f.projects.current()).toBe(resolve(f.desk))
    expect(f.projects.view()).toMatchObject({ current: { name: '书桌', desk: true }, recent: [], status: 'idle' })
    expect(await f.pick(f.code)).toBeUndefined()
    expect(f.projects.current()).toBe(resolve(f.code))
    expect(f.projects.view()).toMatchObject({ current: { name: 'site', desk: false, trusted: true }, desk: { desk: true } })
    expect(f.settings.read().workProjects).toEqual({ current: resolve(f.code), recent: [resolve(f.code)] })
    await f.pick(f.other)
    expect(f.projects.view().recent.map((project) => project.name)).toEqual(['site'])
    expect(f.changed).toHaveBeenCalled()
  })

  it('refuses drive roots, system folders and LCA private data', async () => {
    const f = setup()
    await f.pick(parse(f.root).root)
    expect(f.projects.view().error).toBe('project-invalid')
    await f.pick(join(f.root, 'missing'))
    expect(f.projects.view().error).toBe('project-invalid')
    await f.pick(join(f.data, 'journals'))
    expect(f.projects.view().error).toBe('project-private')
    await f.pick(f.data)
    expect(f.projects.view().error).toBe('project-private')
    expect(f.projects.current()).toBe(resolve(f.desk))
    await f.pick(null)
    expect(f.projects.view()).not.toHaveProperty('error')
  })

  it('only switches back to her desk or a recent project, and never mid-turn', async () => {
    const f = setup()
    await f.pick(f.code)
    expect(f.projects.dispatch(f.command({ type: 'project.select', path: f.other }))).toBe('invalid-command')
    expect(f.projects.dispatch(f.command({ type: 'project.select', path: f.desk }))).toBeUndefined()
    expect(f.projects.current()).toBe(resolve(f.desk))
    f.setBusy(true)
    expect(f.projects.dispatch(f.command({ type: 'project.select', path: f.code }))).toBeUndefined()
    expect(f.projects.view().error).toBe('project-busy')
    expect(f.projects.current()).toBe(resolve(f.desk))
    f.setBusy(false)
    f.projects.dispatch(f.command({ type: 'project.select', path: f.code }))
    expect(f.projects.current()).toBe(resolve(f.code))
    expect(f.projects.dispatch(f.command({ type: 'project.untrust', path: f.other }))).toBe('invalid-command')
    f.projects.dispatch(f.command({ type: 'project.untrust', path: f.code }))
    expect(f.untrust).toHaveBeenCalledWith(resolve(f.code))
    f.projects.dispatch(f.command({ type: 'project.select', path: f.desk }))
    f.projects.dispatch(f.command({ type: 'project.forget', path: f.code }))
    expect(f.projects.view().recent).toEqual([])
  })
})

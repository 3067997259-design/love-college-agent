import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AppCommand, PublicErrorCode, SkillsView, SkillView } from '../../shared'
import type { Clock } from '../clock'
import type { ExtensionRuntime } from './extensions'
import { atomicJson } from '../../../dsh/lca-bridge/profile.js'
import { fingerprintDirectory } from '../../../dsh/lca-bridge/extension-files.js'
import { assertSkillPath } from '../../../dsh/lca-bridge/skill-files.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
type Imported = { path: string; fingerprint: string }
export function createSkills(options: {
  dataDir: string; clock: Clock; project(): string; blocked(): boolean
  choose(): Promise<string | null>
  withRuntime<T>(job: (runtime: ExtensionRuntime) => Promise<T>): Promise<T>
  approve(input: { id: string; question: string; signal: AbortSignal }): Promise<boolean>
  changed(): void
}) {
  const file = join(options.dataDir, 'skills-imports.json'), profileRoot = join(options.dataDir, 'dsh-home', 'skills')
  const imported: Imported[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  if (!Array.isArray(imported) || imported.some((entry) => typeof entry.path !== 'string' || typeof entry.fingerprint !== 'string')) throw new Error('SKILLS_INVALID')
  const state: SkillsView = { status: 'unavailable', projectKey: '', items: [], operation: null, error: null }
  let locations = new Map<string, string>(), job: Promise<void> | null = null, abort: AbortController | null = null, closed = false
  const projectKey = () => hash(resolve(options.project()).toLowerCase())
  const notify = () => { if (!closed) options.changed() }
  const record = () => {
    mkdirSync(options.dataDir, { recursive: true })
    appendFileSync(join(options.dataDir, 'skill-events.jsonl'), JSON.stringify({ id: randomUUID(), atMs: options.clock.nowMs(), operation: state.operation }) + '\n', { mode: 0o600 })
    notify()
  }
  const refresh = async (runtime: ExtensionRuntime, cwd: string) => {
    const reply = await runtime.host.extensions({ action: 'skills', cwd })
    if (!reply.skills) throw new Error('SKILLS_UNAVAILABLE')
    const next = new Map<string, string>()
    state.items = reply.skills.items.map(({ path, ...item }): SkillView => {
      if (path) next.set(item.id, path)
      const owned = path && imported.find((entry) => resolve(entry.path) === resolve(dirname(path)))
      let removable = false
      if (owned && basename(path) === 'SKILL.md') {
        try { assertSkillPath(owned.path, item.source === 'profile' ? profileRoot : join(cwd, '.dsh', 'skills')); removable = fingerprintDirectory(owned.path) === owned.fingerprint } catch { /* changed files are never removed using an old grant */ }
      }
      return { ...item, removable, fingerprint: removable && owned ? owned.fingerprint : item.fingerprint }
    })
    locations = next; state.projectKey = hash(resolve(cwd).toLowerCase()); state.status = reply.skills.complete ? 'ready' : 'failed'
    state.error = reply.skills.complete ? null : { code: 'configuration-failed', retryable: true }; notify()
  }
  const launch = (run: () => Promise<void>) => {
    job = Promise.resolve(); state.status = 'loading'; state.error = null
    job = run().catch(() => {
      state.status = 'failed'; state.error = { code: 'configuration-failed', retryable: false }
      if (state.operation?.outcome === 'pending') { state.operation.phase = 'settled'; state.operation.outcome = abort?.signal.aborted ? 'cancelled' : 'failed'; record() }
    }).finally(() => { job = null; abort = null; notify() })
    notify()
  }
  return {
    view: (): SkillsView => structuredClone(state.projectKey && state.projectKey !== projectKey() ? { ...state, status: 'unavailable', items: [], projectKey: projectKey() } : state),
    busy: () => job !== null,
    idle: async () => { await job },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (closed || !command.type.startsWith('skills.')) return 'unavailable'
      if (command.type === 'skills.cancel') {
        if (state.operation?.id !== command.operationId || state.operation.outcome !== 'pending' || !abort) return 'stale-candidate'
        abort.abort(); return
      }
      if (job || options.blocked()) return 'unavailable'
      const cwd = options.project()
      if (command.type === 'skills.refresh') { launch(() => options.withRuntime((runtime) => refresh(runtime, cwd))); return }
      if (command.type !== 'skills.import' && command.type !== 'skills.remove') return 'invalid-command'
      const selected = command.type === 'skills.remove' ? state.items.find((row) => row.id === command.skillId) : undefined
      if (command.type === 'skills.remove' && (command.projectKey !== projectKey() || !selected?.removable || selected.fingerprint !== command.fingerprint)) return 'stale-candidate'
      const target = selected ? locations.get(selected.id) : undefined
      const operation: NonNullable<SkillsView['operation']> = { id: randomUUID(), action: command.type === 'skills.import' ? 'import' : 'remove', phase: 'preparing', outcome: 'pending' }
      state.operation = operation; abort = new AbortController(); const signal = abort.signal; record()
      launch(() => options.withRuntime(async (runtime) => {
        let staged: string | undefined, destination: string, name: string, fingerprint: string, root: string
        if (command.type === 'skills.import') {
          const source = await options.choose()
          if (!source || signal.aborted || closed) { operation.outcome = 'cancelled'; operation.phase = 'settled'; record(); await refresh(runtime, cwd); return }
          assertSkillPath(source, source); fingerprint = fingerprintDirectory(source)
          staged = join(options.dataDir, 'skill-candidates', operation.id, 'candidate')
          mkdirSync(dirname(staged), { recursive: true }); cpSync(source, staged, { recursive: true, filter: (path) => !['.git', 'node_modules'].includes(basename(path)) })
          if (fingerprintDirectory(staged) !== fingerprint) throw new Error('SKILL_CHANGED')
          const checked = await runtime.host.extensions({ action: 'skill-inspect', directory: staged })
          name = checked.skills?.items[0]?.name ?? ''
          if (!checked.skills?.complete || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 100) throw new Error('SKILL_INVALID')
          root = command.scope === 'project' ? join(cwd, '.dsh', 'skills') : profileRoot
          destination = join(root, name); assertSkillPath(destination, root)
          if (existsSync(destination)) throw new Error('SKILL_ALREADY_EXISTS')
        } else {
          if (!target || !selected) throw new Error('SKILL_MISSING')
          name = selected.name; destination = dirname(target); fingerprint = selected.fingerprint
          root = selected.source === 'profile' ? profileRoot : join(cwd, '.dsh', 'skills')
        }
        operation.phase = 'awaiting-approval'; record()
        const scope = root === profileRoot ? '此存档（所有项目）' : '当前项目'
        const allowed = await options.approve({ id: operation.id, signal, question: `${operation.action === 'import' ? '导入' : '移除'}技能 ${name}（${scope}，指纹 ${fingerprint.slice(0, 12)}）？${operation.action === 'import' ? '技能说明会成为她工作时可读取的指引；同名时项目来源优先。' : '移除的副本会保留在本机备份目录。'}` })
        if (!allowed || signal.aborted || closed || cwd !== options.project()) { operation.outcome = 'cancelled'; operation.phase = 'settled'; record(); if (!closed) await refresh(runtime, cwd); return }
        assertSkillPath(destination, root)
        if (staged) {
          if (existsSync(destination) || fingerprintDirectory(staged) !== fingerprint) throw new Error('SKILL_CHANGED')
          const pending = join(dirname(root), 'lca-skill-staging', operation.id)
          assertSkillPath(pending, dirname(root)); mkdirSync(dirname(pending), { recursive: true }); mkdirSync(root, { recursive: true })
          cpSync(staged, pending, { recursive: true })
          if (fingerprintDirectory(pending) !== fingerprint) throw new Error('SKILL_CHANGED')
          // Store ownership before the atomic rename. Cold recovery only observes; it never replays this approval.
          imported.push({ path: destination, fingerprint }); atomicJson(file, imported)
          assertSkillPath(destination, root); renameSync(pending, destination)
        } else {
          if (fingerprintDirectory(destination) !== fingerprint) throw new Error('SKILL_CHANGED')
          const archive = join(dirname(root), 'lca-skill-removed', operation.id)
          assertSkillPath(archive, dirname(root)); mkdirSync(dirname(archive), { recursive: true }); renameSync(destination, archive)
        }
        operation.phase = 'settled'; operation.outcome = 'succeeded'; record(); await refresh(runtime, cwd)
      })); return
    },
    disconnected: () => { state.status = 'unavailable'; state.items = []; notify() },
    close: () => { closed = true; abort?.abort() },
  }
}
export type SkillsService = ReturnType<typeof createSkills>

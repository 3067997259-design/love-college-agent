import { existsSync, statSync } from 'node:fs'
import { basename, parse, resolve, sep } from 'node:path'
import type { AppCommand, PublicErrorCode, WorkProjectsView, WorkProjectView } from '../../shared'
import type { SettingsStore } from '../config/settings'

const RECENT = 6
type Refusal = NonNullable<WorkProjectsView['error']>
const key = (path: string) => resolve(path).toLowerCase()
const within = (path: string, root: string) => { const a = key(path); const b = key(root); return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) }

/**
 * Where she works with DSH: her desk in the room by default, or a folder the user picked in the book.
 * Only main opens the folder dialog; the book can switch back to the desk or to a recent project. A
 * project must be an existing folder that is not a drive root or a system folder, and that neither holds
 * nor sits inside LCA's private data.
 */
export function createProjects(options: {
  settings: SettingsStore; desk: string; privateRoots: readonly string[]
  trusted(path: string): boolean; untrust(path: string): void; busy(): boolean
  choose(): Promise<string | null>; changed(): void
}) {
  const desk = resolve(options.desk)
  const systemRoots = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData].filter((root): root is string => !!root)
  let picking = false
  let error: Refusal | undefined
  const stored = () => options.settings.read().workProjects ?? { current: null, recent: [] }

  const refusal = (path: string): Refusal | null => {
    const full = resolve(path)
    if (key(full) === key(desk)) return null
    if (!existsSync(full) || !statSync(full).isDirectory() || key(parse(full).root) === key(full)) return 'project-invalid'
    if (systemRoots.some((root) => within(full, root))) return 'project-invalid'
    if (options.privateRoots.some((root) => within(full, root) || within(root, full))) return 'project-private'
    return null
  }
  const current = () => { const chosen = stored().current; return chosen && !refusal(chosen) ? resolve(chosen) : desk }
  const item = (path: string): WorkProjectView => ({ path, name: key(path) === key(desk) ? '书桌' : basename(path) || path, desk: key(path) === key(desk), trusted: options.trusted(path) })
  const select = (path: string) => {
    const full = resolve(path)
    options.settings.update((draft) => {
      const recent = (draft.workProjects?.recent ?? []).filter((entry) => key(entry) !== key(full))
      draft.workProjects = { current: key(full) === key(desk) ? null : full, recent: key(full) === key(desk) ? recent : [full, ...recent].slice(0, RECENT) }
    })
  }

  return {
    /** The folder her DSH session works in right now. */
    current,
    view: (): WorkProjectsView => {
      const now = current()
      return { current: item(now), desk: item(desk), recent: stored().recent.filter((path) => key(path) !== key(now) && !refusal(path)).map(item),
        status: picking ? 'picking' : 'idle', ...(error ? { error } : {}) }
    },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      error = undefined
      if (command.type === 'project.forget') {
        options.settings.update((draft) => { if (draft.workProjects) draft.workProjects.recent = draft.workProjects.recent.filter((entry) => key(entry) !== key(command.path)) })
        return
      }
      if (command.type === 'project.untrust') { if (key(command.path) !== key(current())) return 'invalid-command'; options.untrust(current()); return }
      // Switching folders mid-turn would leave her work half in one project and half in another.
      if (options.busy()) { error = 'project-busy'; return }
      if (command.type === 'project.select') {
        const known = key(command.path) === key(desk) || stored().recent.some((entry) => key(entry) === key(command.path))
        if (!known) return 'invalid-command'
        const refused = refusal(command.path)
        if (refused) { error = refused; return }
        select(command.path); return
      }
      if (command.type === 'project.pick') {
        if (picking) return
        picking = true
        void options.choose().then((path) => {
          if (path) { const refused = refusal(path); if (refused) error = refused; else if (options.busy()) error = 'project-busy'; else select(path) }
        }, () => {}).finally(() => { picking = false; options.changed() })
        return
      }
      return 'invalid-command'
    },
  }
}
export type ProjectsService = ReturnType<typeof createProjects>

import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot, WorkProjectView } from '../../../shared'
import book from '../voice/book.zh.json'
import { sendCommand, type CommandBody } from './command'
import { fill } from './life/text'

const words = book.project
const BUSY = new Set(['queued', 'running', 'waiting-user', 'cancelling'])

/**
 * 输入框上沿的小纸签：她写代码、运行命令在哪个文件夹。默认是她的书桌；点开可以换到最近的项目，
 * 或者让主进程弹出选文件夹的窗口。她干活的时候不能换。
 */
export function ProjectChip({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const work = snapshot.work
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [open])
  if (!work) return null
  const busy = !!snapshot.task && BUSY.has(snapshot.task.status)
  const send = (body: CommandBody) => { void sendCommand(bridge, snapshot.epoch, body) }
  const choose = (project: WorkProjectView) => { if (project.path !== work.current.path) send({ type: 'project.select', path: project.path }); setOpen(false) }
  const options = [work.desk, ...work.recent.filter((project) => !project.desk)]
  if (!options.some((project) => project.path === work.current.path)) options.splice(1, 0, work.current)
  return (
    <div className="project-chip" ref={root}>
      <button type="button" className="project-chip-button" aria-haspopup="menu" aria-expanded={open} title={`${words.chipTitle}\n${work.current.path}`} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
        <span>{fill(words.chip, { name: work.current.name })}</span>
        {work.current.trusted && <span className="project-trusted" title={words.trustedTitle}>{words.trusted}</span>}
      </button>
      {open && (
        <div className="project-menu" role="menu" aria-label={words.menuTitle}>
          <p className="project-menu-title">{words.menuTitle}</p>
          {options.map((project) => (
            <button key={project.path} type="button" role="menuitemradio" aria-checked={project.path === work.current.path} disabled={busy} title={project.path} onClick={() => choose(project)}>
              <span className="project-name">{project.desk ? words.desk : project.name}</span>
              {project.trusted && <span className="project-trusted">{words.trusted}</span>}
              <small>{project.desk ? words.deskHint : project.path}</small>
            </button>
          ))}
          <button type="button" role="menuitem" className="project-pick" disabled={busy || work.status === 'picking'} onClick={() => send({ type: 'project.pick' })}>
            {work.status === 'picking' ? words.picking : words.pick}
          </button>
          {work.current.trusted && (
            <button type="button" role="menuitem" className="project-untrust" onClick={() => { send({ type: 'project.untrust', path: work.current.path }); setOpen(false) }}>
              {fill(words.untrust, { name: work.current.desk ? words.desk : work.current.name })}
            </button>
          )}
          {(busy || work.error) && <p className="project-menu-note" role="status">{busy ? words.busy : words.errors[work.error!]}</p>}
        </div>
      )}
    </div>
  )
}

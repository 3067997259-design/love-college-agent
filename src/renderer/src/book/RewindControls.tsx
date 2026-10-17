import { useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { sendCommand } from './command'
import words from '../voice/rewind.zh.json'

export function RewindControls({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const [error, setError] = useState(''); const view = snapshot.heartFlow?.rewind
  if (!snapshot.heartFlow?.activeId || !view) return null
  const pending = view.status === 'awaiting-confirmation'; const running = view.status === 'running'
  const key = snapshot.epoch + ':' + view.id
  const send = async (type: 'flow.rewind.apply' | 'flow.rewind.cancel') => { const result = await sendCommand(bridge, snapshot.epoch, { type, rewindId: view.id }); setError(result.ok ? '' : key) }
  return <section className="card" aria-label={words.title} data-rewind={view.status}>
    <strong>{words.title}</strong><p>{words.status[view.status]} · {view.appliedFiles} / {view.paths.length} {words.files}</p>
    <p>{words.count.replace('{count}', String(view.changeCount))}</p><ul>{view.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
    <p>{words.limit}</p>
    {pending && <button type="button" className="btn btn-primary" onClick={() => void send('flow.rewind.apply')}>{words.confirm}</button>}
    {(pending || running) && <button type="button" className="btn btn-ghost" onClick={() => void send('flow.rewind.cancel')}>{words.cancel}</button>}
    {view.error && <p role="alert">{words.errors[view.error]}</p>}{error === key && <p role="alert">{words.failed}</p>}
  </section>
}

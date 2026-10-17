import { useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { sendCommand, type CommandBody } from './command'
import words from '../voice/commands.zh.json'
import { commandScriptPreview } from './command-script'

export function CommandControls({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const command = snapshot.heartFlow?.command; const [busy, setBusy] = useState(false); const [error, setError] = useState(false)
  if (!command) return null
  const script = commandScriptPreview(command.command)
  async function send(body: CommandBody) { setBusy(true); try { const result = await sendCommand(bridge, snapshot.epoch, body); setError(!result.ok) } finally { setBusy(false) } }
  return <section className="card" data-desk-command={command.status} aria-label={words.title}>
    <strong>{words.status[command.status]}</strong><p>{words.scope}</p>
    <pre>{command.command}</pre>
    {script !== null && <details open={command.status === 'awaiting-approval'}><summary>{words.script}</summary><pre>{script}</pre></details>}
    {command.error?.code === 'command-encoding-unsupported' && <p role="alert">{words.encoding}</p>}
    <small>{command.timeoutMs / 1000} s · {command.fileCount} {words.snapshot} {command.snapshotHash?.slice(0, 12) ?? '…'}</small>
    {command.status === 'awaiting-approval' && <div>
      <button className="btn btn-primary" disabled={busy} onClick={() => void send({ type: 'flow.command.approve', commandId: command.id, allow: true })}>{words.allow}</button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => void send({ type: 'flow.command.approve', commandId: command.id, allow: false })}>{words.deny}</button>
    </div>}
    {['preparing', 'running'].includes(command.status) && <button className="btn btn-ghost" disabled={busy} onClick={() => void send({ type: 'flow.command.cancel', commandId: command.id })}>{words.cancel}</button>}
    {command.outcome && <p>{words.receipt}：{command.outcome.exitCode ?? '—'} / {command.outcome.appliedFiles} · {words.publication[command.outcome.publication]}
      <button className="btn btn-ghost" disabled={busy} onClick={() => void send({ type: 'flow.command.open', commandId: command.id })}>{words.output}</button>
    </p>}
    {error && <p role="alert">{words.error}</p>}
  </section>
}

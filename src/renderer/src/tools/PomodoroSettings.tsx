import { useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { sendCommand, type CommandBody } from '../book/command'
import { SettingsIssue, settingStatus } from './SettingsIssue'
import text from '../voice/settings.zh.json'
const words = text.pomodoro

export function PomodoroSettings({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [plannedCount, setPlannedCount] = useState(2); const [demo, setDemo] = useState(false); const [error, setError] = useState('')
  const send = async (body: CommandBody) => { const result = await sendCommand(bridge, snapshot.epoch, body); setError(result.ok ? '' : result.code) }
  const view = snapshot.pomodoro
  return <><h2>{words.title}</h2><div aria-label="番茄钟控制" data-phase={view.phase} data-status={view.status}>
    <p>{words.phase[view.phase]} · {Math.ceil(view.remainingMs / 1000)} {words.seconds} · {view.focusIndex}/{view.plannedCount}</p>
    {view.phaseDurationMs > 0 && <progress aria-label={words.progress} max={view.phaseDurationMs} value={Math.max(0, view.phaseDurationMs - view.remainingMs)} />}
    <label>{words.count}<select value={plannedCount} onChange={(event) => setPlannedCount(Number(event.target.value))}>{[1, 2, 4, 6].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
    <label><input type="checkbox" checked={demo} onChange={(event) => setDemo(event.target.checked)} />{words.demo}</label>
    <button onClick={() => void send({ type: 'pomodoro.plan', plan: { label: demo ? words.demoLabel : words.label, plannedCount, focusDurationMs: demo ? 60_000 : 25 * 60_000, shortBreakDurationMs: demo ? 20_000 : 5 * 60_000, longBreakDurationMs: demo ? 20_000 : 15 * 60_000, longBreakEvery: 4, timing: demo ? 'demo' : 'standard' } })}>{words.proposal}</button>
    {view.plan && <p>{view.plan.label} · {settingStatus(view.plan.status)} · {view.plan.timing === 'demo' ? words.demoTime : words.realTime}</p>}
    {view.proposal && <><p>{view.proposal.label} · {words.pending} · {words.dayCount.replace('{count}', String(view.proposal.plannedCount))}</p><button onClick={() => void send({ type: 'pomodoro.confirm', planId: view.proposal!.id })}>{words.confirm}</button><button onClick={() => void send({ type: 'pomodoro.discard', planId: view.proposal!.id })}>{words.discard}</button></>}
    {view.plan?.status === 'confirmed' && view.status === 'idle' && <button disabled={snapshot.companion.lightsOut} onClick={() => void send({ type: 'pomodoro.start', planId: view.plan!.id })}>{words.start}</button>}
    {view.status === 'running' && <button onClick={() => void send({ type: 'pomodoro.pause' })}>{words.pause}</button>}
    {view.status === 'paused' && <button disabled={snapshot.companion.lightsOut} onClick={() => void send({ type: 'pomodoro.resume' })}>{words.resume}</button>}
    {view.plan && view.plan.status !== 'finished' && <button onClick={() => void send({ type: 'pomodoro.stop' })}>{words.stop}</button>}<SettingsIssue code={error} />
  </div></>
}

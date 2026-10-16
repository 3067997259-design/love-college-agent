import { randomUUID } from 'node:crypto'
import type { AppCommand, PomodoroPlanInput, PomodoroView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { Scheduler } from '../scheduler'
import type { JournalInput } from '../journal/schema'
import { completedFocuses, idleTimer, normalizePomodoro, planSchema } from './schema'

type StateEvent = Extract<JournalInput, { type: 'pomodoro/state' }>
export function createPomodoro(options: { clock: Clock; store: SessionStore; scheduler: Scheduler; changed(): void; stateChanged(): void; emit(id: string, text: string): void }) {
  const { clock, store, scheduler } = options
  let disposed = false
  const read = () => {
    const view = normalizePomodoro(store.projection().pomodoro)
    if (view.status === 'running' && view.endsAtMs !== null) view.remainingMs = Math.max(0, view.endsAtMs - clock.nowMs())
    return view
  }
  const flush = () => {
    for (const event of store.projection().pomodoroEvents) options.emit(event.id, event.text)
  }
  const persist = (view: PomodoroView, cause: StateEvent['cause'], pauseReason: StateEvent['pauseReason'] = null, mode?: StateEvent['mode'], fact?: string) => {
    store.append({ type: 'pomodoro/state', view: normalizePomodoro(view), cause, pauseReason, ...(mode ? { mode } : {}), ...(fact ? { event: { id: randomUUID(), text: fact } } : {}) })
    options.changed(); options.stateChanged(); arm(); flush()
  }
  const finish = (interrupted = false) => {
    const view = read(); const plan = view.plan
    if (!plan || (view.status !== 'running' && !(interrupted && view.status === 'paused'))) return
    if (view.phase === 'focus') {
      const index = interrupted ? Math.max(0, view.focusIndex - 1) : view.focusIndex
      const long = !interrupted && index % plan.longBreakEvery === 0
      const duration = long ? plan.longBreakDurationMs : plan.shortBreakDurationMs
      persist({ ...view, status: 'running', phase: long ? 'long-break' : 'short-break', phaseDurationMs: duration, remainingMs: duration, endsAtMs: clock.nowMs() + duration, focusIndex: index },
        interrupted ? 'interrupted' : 'elapsed', null, 'rest', JSON.stringify({ kind: interrupted ? 'focus-interrupted' : 'focus-ended', planId: plan.id, focusIndex: view.focusIndex, occurredAtMs: clock.nowMs() }))
    } else if (view.phase === 'short-break' || view.phase === 'long-break') {
      const finished = view.focusIndex >= plan.plannedCount
      persist({ ...view, phase: 'idle', status: 'idle', remainingMs: 0, endsAtMs: null, phaseDurationMs: 0, plan: { ...plan, status: finished ? 'finished' : 'confirmed' } },
        'elapsed', null, 'rest', JSON.stringify({ kind: 'break-ended', planId: plan.id, focusIndex: view.focusIndex, finished, awaitingUserStart: !finished, occurredAtMs: clock.nowMs() }))
    }
  }
  const arm = () => {
    scheduler.cancel('pomodoro.phase')
    const view = read()
    if (!disposed && view.status === 'running' && view.endsAtMs !== null) scheduler.schedule('pomodoro.phase', view.endsAtMs, () => finish())
  }
  const propose = (input: PomodoroPlanInput, source: 'user' | 'assistant'): PublicErrorCode | undefined => {
    const parsed = planSchema.safeParse(input)
    if (!parsed.success) return 'invalid-command'
    const view = read(); if (parsed.data.plannedCount < view.focusIndex) return 'invalid-command'
    const proposal = { ...parsed.data, id: randomUUID(), createdAtMs: clock.nowMs(), status: 'proposed' as const, source }
    persist({ ...view, proposal }, 'plan', store.projection().pomodoroPause)
  }
  const start = (planId: string): PublicErrorCode | undefined => {
    const view = read(); const plan = view.plan
    if (store.projection().lightsOut || view.status !== 'idle') return 'unavailable'
    if (!plan || plan.id !== planId || plan.status !== 'confirmed' || view.focusIndex >= plan.plannedCount) return 'invalid-command'
    const duration = plan.focusDurationMs
    persist({ ...view, phase: 'focus', status: 'running', remainingMs: duration, endsAtMs: clock.nowMs() + duration, phaseDurationMs: duration, focusIndex: view.focusIndex + 1 }, 'started', null, 'quiet',
      JSON.stringify({ kind: 'focus-started', planId: plan.id, focusIndex: view.focusIndex + 1, occurredAtMs: clock.nowMs() }))
  }
  const pause = (reason: 'manual' | 'lights'): PublicErrorCode | undefined => {
    const view = read()
    if (view.status !== 'running') return 'unavailable'
    persist({ ...view, status: 'paused', endsAtMs: null }, 'paused', reason)
  }
  const resume = (): PublicErrorCode | undefined => {
    const view = read()
    if (view.status !== 'paused' || store.projection().lightsOut) return 'unavailable'
    persist({ ...view, status: 'running', endsAtMs: clock.nowMs() + view.remainingMs }, 'resumed')
  }
  const stop = (): PublicErrorCode | undefined => {
    const view = read()
    if (!view.plan || view.plan.status === 'finished') return 'unavailable'
    persist({ ...idleTimer(), plan: { ...view.plan, status: 'finished' as const }, plannedCount: view.plannedCount, focusIndex: completedFocuses(view), ...(view.proposal ? { proposal: view.proposal } : {}) }, 'stopped', null, 'rest')
  }
  const reconcile = () => {
    if (disposed) return
    const view = read()
    if (store.projection().lightsOut) {
      if (view.status === 'running') pause('lights')
    } else if (view.status === 'running' && view.endsAtMs !== null && view.endsAtMs <= clock.nowMs()) finish()
    arm(); flush()
  }
  scheduler.schedule('pomodoro.outbox', clock.nowMs() + 1000, flush, { everyMs: 1000 })
  return { read, propose, start, pause: () => pause('manual'), resume, stop, reconcile,
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type === 'pomodoro.plan') return propose(command.plan, 'user')
      if (command.type === 'pomodoro.confirm') {
        const view = read()
        const proposal = view.proposal
        if (!proposal || proposal.id !== command.planId || proposal.plannedCount < view.focusIndex) return 'invalid-command'
        const plan = { ...proposal, status: view.status === 'idle' && proposal.plannedCount === view.focusIndex ? 'finished' as const : 'confirmed' as const }
        delete view.proposal
        persist({ ...view, plan, plannedCount: plan.plannedCount }, 'confirmed', store.projection().pomodoroPause); return
      }
      if (command.type === 'pomodoro.discard') {
        const view = read(); if (view.proposal?.id !== command.planId) return 'invalid-command'
        delete view.proposal; persist(view, 'discarded', store.projection().pomodoroPause); return
      }
      if (command.type === 'pomodoro.start') return start(command.planId)
      if (command.type === 'pomodoro.pause') return pause('manual')
      if (command.type === 'pomodoro.resume') return resume()
      if (command.type === 'pomodoro.stop') return stop()
      return 'unavailable'
    },
    stateChanged: (command: AppCommand) => {
      const view = read()
      if (command.type === 'lights.set') {
        if (command.lightsOut && view.status === 'running') pause('lights')
        else if (!command.lightsOut && view.status === 'paused' && store.projection().pomodoroPause === 'lights') resume()
      } else if (command.type === 'mode.set' && command.mode === 'rest' && !store.projection().lightsOut && view.phase === 'focus' && view.status !== 'idle') finish(true)
    },
    dispose: () => { disposed = true; scheduler.cancel('pomodoro.phase'); scheduler.cancel('pomodoro.outbox') },
  }
}
export type PomodoroService = ReturnType<typeof createPomodoro>

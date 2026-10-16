import { createHash } from 'node:crypto'
import type { AppCommand, OutingPlace, OutingView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { Scheduler } from '../scheduler'
import type { SessionStore } from '../store/session'
import { lifeSchema } from './schema'
const DAY = 86_400_000
export const calendarDay = (clock: Clock, at = clock.nowMs()) => clock.iso(at + 8 * 3600000).slice(0, 10)
export const isWeekend = (clock: Clock, day: string) => { const weekday = ((Math.floor(clock.parse(day + 'T12:00:00+08:00') / DAY) + 4) % 7 + 7) % 7; return weekday === 0 || weekday === 6 }
export function createLife(options: { store: SessionStore; clock: Clock; scheduler: Scheduler; working(): boolean; changed(): void; emit(id: string, facts: string): void; restored?: boolean }) {
  const { clock, store } = options; const rows = () => store.history?.() ?? store.records()
  const previous = rows().findLast((row) => row.type === 'life/state')
  let state = lifeSchema.parse(previous?.type === 'life/state' ? structuredClone(previous.view) : { dayKey: calendarDay(clock), userSchedule: 'auto', locationId: 'room', settledUntilMs: clock.nowMs(), agenda: [], outings: [], items: [] })
  const pendingFacts = new Map<string, string>()
  const save = () => { state.outings = state.outings.slice(-500); state.items = state.items.slice(-500); state = lifeSchema.parse(state); store.append({ type: 'life/state', view: state }); options.changed(); for (const [id, facts] of pendingFacts) options.emit(id, facts); pendingFacts.clear() }
  const working = () => options.working() || store.projection().mode !== 'rest' || store.projection().pomodoro.phase === 'focus' || state.userSchedule === 'work'
  const resting = (day: string) => state.dayKey === day && state.userSchedule !== 'auto' ? state.userSchedule === 'rest' : isWeekend(clock, day)
  const makeOuting = (day: string, at: number, offline: boolean, place?: OutingPlace): OutingView => {
    const digest = createHash('sha256').update(JSON.stringify([store.scope.userId, store.scope.characterId, day])).digest('hex')
    const destination = place ?? (parseInt(digest.slice(0, 2), 16) % 2 ? 'coast' : 'swing')
    return { id: 'outing:' + digest, place: destination, startsAtMs: at, returnsAtMs: at + 60 * 60000, acquiredAtMs: at + 35 * 60000, item: destination === 'coast' ? 'shell' : 'leaf', status: 'proposed', settledAtMs: null, offline }
  }
  const settle = (outing: OutingView, at: number, cutShort: boolean) => {
    if (outing.status !== 'away' && !outing.offline) return
    outing.status = cutShort ? 'cut_short' : 'returned'; outing.settledAtMs = at; state.locationId = 'room'
    if (at >= outing.acquiredAtMs && !state.items.some((item) => item.outingId === outing.id)) {
      state.items.push({ id: 'item:' + outing.id, outingId: outing.id, dayKey: calendarDay(clock, outing.startsAtMs), place: outing.place, kind: outing.item, acquiredAtMs: outing.acquiredAtMs, display: 'desk' })
      state.items.forEach((item, index) => { item.display = index >= state.items.length - 3 ? 'desk' : 'drawer' })
    }
    pendingFacts.set(outing.id + ':return', JSON.stringify({ fictionalOuting: outing, broughtItem: state.items.find((item) => item.outingId === outing.id)?.kind ?? null, actualWorkWhileOffline: false }))
  }
  const reconcile = (startup = false) => {
    const now = clock.nowMs(); const wasLightsOut = store.projection().lightsOut; let changed = false
    const away = state.outings.findLast((outing) => outing.status === 'away')
    if (options.restored && startup) { if (away) settle(away, Math.min(now, state.settledUntilMs), true); state.locationId = 'room'; state.settledUntilMs = now; save(); return }
    if (startup && previous && !wasLightsOut && now > state.settledUntilMs + 2 * 60000 && !working()) {
      const from = Math.max(state.settledUntilMs, now - 3 * DAY)
      for (let dayAt = from; dayAt <= now; dayAt += DAY) {
        const day = calendarDay(clock, dayAt); const start = clock.parse(day + 'T15:00:00+08:00'); const planned = makeOuting(day, start, true)
        if (!resting(day) || start < from || planned.returnsAtMs > now || state.outings.some((outing) => outing.id === planned.id)) continue
        planned.status = 'away'; state.outings.push(planned); settle(planned, planned.returnsAtMs, false); changed = true
      }
    }
    if (away) {
      if (wasLightsOut || working()) { settle(away, now, true); changed = true }
      else if (now >= away.returnsAtMs) { settle(away, away.returnsAtMs, false); changed = true }
    }
    const today = calendarDay(clock)
    if (today !== state.dayKey || !state.agenda.length) {
      state.dayKey = today; state.userSchedule = 'auto'; state.agenda = ([['read', '09:00'], ['write', '11:00'], ['walk', '15:00']] as const).map(([kind, time]) => ({ kind, atMs: clock.parse(today + 'T' + time + ':00+08:00'), state: 'planned' })); changed = true
    }
    if (!wasLightsOut && !options.working()) for (const item of state.agenda) {
      if (item.state !== 'planned' || now < item.atMs) continue
      // Reading/writing have no producer yet: a due placeholder is not a completed work.
      item.state = item.kind !== 'walk' || !resting(today) || working() ? 'skipped' : 'settled'; changed = true
      if (item.kind === 'walk' && item.state === 'settled' && !state.outings.some((outing) => calendarDay(clock, outing.startsAtMs) === today)) {
        const outing = makeOuting(today, now, false); state.outings.push(outing)
        const lastUser = rows().findLast((row) => row.type === 'user/message')?.atMs ?? now
        if (now - lastUser >= 15 * 60000) { outing.status = 'away'; state.locationId = outing.place }
      }
    }
    if (changed || now - state.settledUntilMs >= 60000 || startup) { state.settledUntilMs = now; save() }
  }
  reconcile(true)
  options.scheduler.schedule('life.settle', clock.nowMs() + 60000, () => reconcile(), { everyMs: 60000 })
  return {
    view: () => structuredClone(state), reconcile,
    foreground: () => { const away = state.outings.findLast((outing) => outing.status === 'away'); if (away) { settle(away, clock.nowMs(), true); state.settledUntilMs = clock.nowMs(); save() } },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (store.projection().lightsOut) return 'unavailable'
      if (command.type === 'life.schedule') { state.userSchedule = command.schedule; if (command.schedule === 'work') { const away = state.outings.findLast((outing) => outing.status === 'away'); if (away) settle(away, clock.nowMs(), true) }; save(); return }
      if (command.type === 'life.propose') { if (working() || state.outings.some((outing) => outing.status === 'away' || outing.status === 'proposed')) return 'unavailable'; const outing = makeOuting(calendarDay(clock), clock.nowMs(), false, command.place); if (state.outings.some((old) => old.id === outing.id)) return 'unavailable'; state.outings.push(outing); save(); return }
      if (command.type === 'life.depart') {
        const outing = state.outings.find((item) => item.id === command.outingId && item.status === 'proposed'); if (!outing || working()) return 'unavailable'
        const delay = Math.max(0, clock.nowMs() - outing.startsAtMs); outing.startsAtMs += delay; outing.returnsAtMs += delay; outing.acquiredAtMs += delay; outing.status = 'away'; state.locationId = outing.place; save(); return
      }
      if (command.type === 'life.return') { const away = state.outings.findLast((outing) => outing.status === 'away'); if (!away) return 'unavailable'; settle(away, clock.nowMs(), true); save(); return }
      return 'invalid-command'
    },
    close: () => { state.settledUntilMs = clock.nowMs(); save(); options.scheduler.cancel('life.settle') },
  }
}
export type LifeService = ReturnType<typeof createLife>

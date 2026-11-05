import { createHash } from 'node:crypto'
import type { AppCommand, OutingPlace, OutingView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { Scheduler } from '../scheduler'
import type { SessionStore } from '../store/session'
import { lifeSchema } from './schema'
import { outingReference, worldFactsNote } from './reference'
import type { LifeWorkService } from './work/service'
const DAY = 86_400_000
/** She takes her walk some time in this afternoon window, once you have been away a while. */
const WALK_WINDOW = { start: '14:00', end: '18:00' } as const
const WALK_IDLE_MS = 15 * 60000
export const calendarDay = (clock: Clock, at = clock.nowMs()) => clock.iso(at + 8 * 3600000).slice(0, 10)
export function createLife(options: { store: SessionStore; clock: Clock; scheduler: Scheduler; working(): boolean; changed(): void; emit(id: string, facts: string): void; restored?: boolean; work?: LifeWorkService }) {
  const { clock, store } = options; const rows = () => store.history?.() ?? store.records()
  const previous = rows().findLast((row) => row.type === 'life/state')
  let state = lifeSchema.parse(previous?.type === 'life/state' ? structuredClone(previous.view) : { dayKey: calendarDay(clock), userSchedule: 'auto', locationId: 'room', settledUntilMs: clock.nowMs(), agenda: [], outings: [], items: [] })
  const pendingFacts = new Map<string, string>()
  const save = () => { state.outings = state.outings.slice(-500); state.items = state.items.slice(-500); state = lifeSchema.parse(state); store.append({ type: 'life/state', view: state }); options.changed(); for (const [id, facts] of pendingFacts) options.emit(id, facts); pendingFacts.clear() }
  const working = () => options.working() || store.projection().sleeping || store.projection().mode !== 'rest' || store.projection().pomodoro.phase === 'focus' || state.userSchedule === 'work'
  // Weekdays included. Only a day the user marked as a work day keeps her in.
  const walkDay = (day: string) => !(state.dayKey === day && state.userSchedule === 'work')
  const digestFor = (day: string) => createHash('sha256').update(JSON.stringify([store.scope.userId, store.scope.characterId, day])).digest('hex')
  /** Her walk varies a little: she is not a 60-minute metronome. Explicit or offline trips keep the fixed hour. */
  const walkDuration = (day: string) => 30 * 60000 + parseInt(digestFor(day).slice(2, 4), 16) % 25 * 60000
  const makeOuting = (day: string, at: number, offline: boolean, place?: OutingPlace, durationMs = 60 * 60000): OutingView => {
    const digest = digestFor(day)
    const destination = place ?? (parseInt(digest.slice(0, 2), 16) % 2 ? 'coast' : 'swing')
    // Only the coast and the swing leave her a keepsake; a bookstore or a rooftop visit brings nothing back to the desk.
    const item = destination === 'coast' ? 'shell' : destination === 'swing' ? 'leaf' : null
    return { id: 'outing:' + digest, place: destination, startsAtMs: at, returnsAtMs: at + durationMs, acquiredAtMs: at + Math.round(durationMs * 0.6), item, status: 'proposed', settledAtMs: null, offline }
  }
  const expireProposals = (now: number) => {
    let changed = false
    for (const outing of state.outings) if (outing.status === 'proposed' && calendarDay(clock, outing.startsAtMs) !== calendarDay(clock, now)) {
      outing.status = 'cancelled'; outing.settledAtMs = now; changed = true
    }
    return changed
  }
  const depart = (outing: OutingView, now: number) => {
    if (outing.status !== 'proposed' || working() || store.projection().lightsOut || state.outings.some((other) => other.status === 'away')) return false
    const delay = Math.max(0, now - outing.startsAtMs); outing.startsAtMs += delay; outing.returnsAtMs += delay; outing.acquiredAtMs += delay
    outing.status = 'away'; state.locationId = outing.place; return true
  }
  const settle = (outing: OutingView, at: number, cutShort: boolean) => {
    if (outing.status !== 'away' && !outing.offline) return
    outing.status = cutShort ? 'cut_short' : 'returned'; outing.settledAtMs = at; state.locationId = state.outings.findLast((other) => other.status === 'away')?.place ?? 'room'
    if (at >= outing.acquiredAtMs && outing.item && !state.items.some((item) => item.outingId === outing.id)) {
      state.items.push({ id: 'item:' + outing.id, outingId: outing.id, dayKey: calendarDay(clock, outing.startsAtMs), place: outing.place, kind: outing.item, acquiredAtMs: outing.acquiredAtMs, display: 'desk' })
      state.items.forEach((item, index) => { item.display = index >= state.items.length - 3 ? 'desk' : 'drawer' })
    }
    pendingFacts.set(outing.id + ':return', JSON.stringify({ fictionalOuting: outingReference(outing, state.items, clock), broughtItem: state.items.find((item) => item.outingId === outing.id)?.kind ?? null, worldFactsNote, actualWorkWhileOffline: false }))
  }
  // Opening the app counts as being here: she does not walk out the moment you arrive.
  const startedAtMs = clock.nowMs()
  // The walk waits for a free afternoon moment instead of one fixed check, so a busy minute no
  // longer cancels the day. She stays in while a pomodoro runs: breaks are for talking with you.
  const walk = (item: (typeof state)['agenda'][number], today: string, now: number) => {
    const todays = state.outings.filter((outing) => outing.status !== 'cancelled' && calendarDay(clock, outing.startsAtMs) === today)
    if (todays.some((outing) => outing.status !== 'proposed')) { item.state = 'settled'; return true }
    if (now >= clock.parse(today + 'T' + WALK_WINDOW.end + ':00+08:00')) { item.state = 'skipped'; return true }
    // A proposal you are still deciding on stays yours to confirm.
    if (todays.length || working() || store.projection().pomodoro.status === 'running') return false
    const present = Math.max(startedAtMs, rows().findLast((row) => row.type === 'user/message')?.atMs ?? 0)
    if (now - present < WALK_IDLE_MS) return false
    const outing = makeOuting(today, now, false, undefined, walkDuration(today))
    if (state.outings.some((old) => old.id === outing.id) || !depart(outing, now)) return false
    state.outings.push(outing); item.state = 'settled'; return true
  }
  const reconcile = (startup = false) => {
    const now = clock.nowMs(); const wasLightsOut = store.projection().lightsOut; let changed = expireProposals(now)
    const overlapping = state.outings.filter((outing) => outing.status === 'away')
    // Older versions could persist simultaneous departures. End them at the saved watermark,
    // never invent additional travel during the untrusted offline interval.
    if (overlapping.length > 1) { for (const outing of overlapping) settle(outing, Math.max(outing.startsAtMs, Math.min(now, state.settledUntilMs)), true); changed = true }
    const away = state.outings.findLast((outing) => outing.status === 'away')
    if (options.restored && startup) { if (away) settle(away, Math.min(now, state.settledUntilMs), true); state.locationId = 'room'; state.settledUntilMs = now; save(); return }
    if (startup && previous && !wasLightsOut && now > state.settledUntilMs + 2 * 60000 && !working()) {
      const from = Math.max(state.settledUntilMs, now - 3 * DAY)
      // Start at Shanghai midnight, not the watermark's time-of-day: otherwise
      // a late shutdown skips a completed trip on the earlier-hour arrival day.
      for (let dayAt = clock.parse(calendarDay(clock, from) + 'T00:00:00+08:00'); dayAt <= now; dayAt += DAY) {
        const day = calendarDay(clock, dayAt); const start = clock.parse(day + 'T15:00:00+08:00'); const planned = makeOuting(day, start, true)
        if (!walkDay(day) || start < from || planned.returnsAtMs > now || state.outings.some((outing) => outing.id === planned.id)) continue
        planned.status = 'away'; state.outings.push(planned); settle(planned, planned.returnsAtMs, false); changed = true
      }
    }
    if (away) {
      if (wasLightsOut || working()) { settle(away, now, true); changed = true }
      else if (now >= away.returnsAtMs) { settle(away, away.returnsAtMs, false); changed = true }
    }
    const today = calendarDay(clock)
    if (today !== state.dayKey || !state.agenda.length) {
      state.dayKey = today; state.userSchedule = 'auto'; state.agenda = ([['read', '09:00'], ['write', '11:00'], ['walk', WALK_WINDOW.start]] as const).map(([kind, time]) => ({ kind, atMs: clock.parse(today + 'T' + time + ':00+08:00'), state: 'planned' })); changed = true
    }
    for (const item of state.agenda) if (item.kind !== 'walk' && options.work?.completed(item.kind, today) && item.state !== 'settled') { item.state = 'settled'; changed = true }
    if (!wasLightsOut && !store.projection().sleeping && !options.working()) for (const item of state.agenda) {
      if (item.kind !== 'walk' && item.state !== 'settled' && now >= item.atMs && options.work?.view().materials.length && options.work.view().source !== 'none') {
        // Only create today's online work. Offline date reconciliation above never invokes a producer.
        options.work.ensure(item.kind, today)
        if (item.state !== 'planned') { item.state = 'planned'; changed = true }
        continue
      }
      if (item.state !== 'planned' || now < item.atMs) continue
      if (item.kind === 'walk') { if (walk(item, today, now)) changed = true; continue }
      // Missing materials/model are skipped, never passed off as a completed work.
      item.state = 'skipped'; changed = true
    }
    if (changed || now - state.settledUntilMs >= 60000 || startup) { state.settledUntilMs = now; save() }
  }
  reconcile(true)
  options.scheduler.schedule('life.settle', clock.nowMs() + 60000, () => reconcile(), { everyMs: 60000 })
  return {
    view: () => ({ ...structuredClone(state), ...(options.work ? { work: options.work.view() } : {}) }), reconcile,
    foreground: () => { const away = state.outings.findLast((outing) => outing.status === 'away'); if (away) { settle(away, clock.nowMs(), true); state.settledUntilMs = clock.nowMs(); save() } },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (expireProposals(clock.nowMs())) save()
      if (store.projection().lightsOut) return 'unavailable'
      if (command.type === 'life.schedule') { state.userSchedule = command.schedule; if (command.schedule === 'work') { const away = state.outings.findLast((outing) => outing.status === 'away'); if (away) settle(away, clock.nowMs(), true) }; save(); return }
      if (command.type === 'life.propose') { if (working() || state.outings.some((outing) => outing.status === 'away' || outing.status === 'proposed')) return 'unavailable'; const outing = makeOuting(calendarDay(clock), clock.nowMs(), false, command.place); if (state.outings.some((old) => old.id === outing.id)) return 'unavailable'; state.outings.push(outing); save(); return }
      if (command.type === 'life.depart') {
        const outing = state.outings.find((item) => item.id === command.outingId && item.status === 'proposed'); if (!outing || !depart(outing, clock.nowMs())) return 'unavailable'
        save(); return
      }
      if (command.type === 'life.return') { const away = state.outings.findLast((outing) => outing.status === 'away'); if (!away) return 'unavailable'; settle(away, clock.nowMs(), true); save(); return }
      return 'invalid-command'
    },
    close: () => { state.settledUntilMs = clock.nowMs(); save(); options.scheduler.cancel('life.settle') },
  }
}
export type LifeService = ReturnType<typeof createLife>

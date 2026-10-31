import type { AgentView, AgentWork, AgentWorkArea, CollaborationView } from '../../shared/collaboration'
import type { DshMemberStep } from '../../shared/dsh-protocol'
import type { Clock } from '../clock'
import { workArea } from './tool-kinds'

type Member = AgentView & { step?: DshMemberStep | null }
type Slice = { area: AgentWorkArea | null; start: number; end: number }
type Focus = { step: DshMemberStep; since: number; area: AgentWorkArea | null; areaSince: number; focus: AgentWorkArea | null; history: Slice[] }
const WINDOW = 30_000, HOLD = 6_000, LONG = 20_000
const keyOf = (member: AgentView) => JSON.stringify(member.address)

/** Main-clock state only. No arguments or DSH wall time; tool names are erased at projection. */
export function createMemberFocus(clock: Clock, kind: (tool: string) => string, changed: (view: CollaborationView) => void) {
  const states = new Map<string, Focus>()
  let latest: CollaborationView | undefined, stop: (() => void) | undefined
  const work = (state: Focus, now: number): AgentWork => {
    const cutoff = now - WINDOW
    state.history = state.history.filter((slice) => slice.end > cutoff)
    const totals = new Map<AgentWorkArea, number>()
    for (const slice of [...state.history, { area: state.area, start: state.areaSince, end: now }]) {
      if (slice.area) totals.set(slice.area, (totals.get(slice.area) ?? 0) + Math.max(0, slice.end - Math.max(cutoff, slice.start)))
    }
    const best = Math.max(0, ...totals.values())
    if (state.area && now - state.areaSince >= HOLD && (totals.get(state.area) ?? 0) >= best) state.focus = state.area
    return { phase: state.step.phase, templateId: state.step.phase === 'tool' && state.step.tool ? kind(state.step.tool) : null,
      sinceMs: state.since, focus: state.focus, long: state.step.phase === 'thinking' && now - state.since >= LONG }
  }
  const project = (): CollaborationView => ({ ...latest!, members: latest!.members.map((raw: Member) => {
    // Do not forward either the raw step or the deprecated raw activityLabel.
    const { step: _step, activityLabel: _label, ...member } = raw
    void _step; void _label
    const state = states.get(keyOf(member))
    return { ...member, work: state ? work(state, clock.nowMs()) : null }
  }) })
  const schedule = () => {
    stop?.(); stop = undefined
    const now = clock.nowMs(), delays: number[] = []
    for (const state of states.values()) {
      if (state.step.phase === 'thinking' && now < state.since + LONG) delays.push(state.since + LONG - now)
      if (state.area && state.focus !== state.area) delays.push(Math.max(1, Math.min(1000, state.areaSince + HOLD - now > 0 ? state.areaSince + HOLD - now : 1000)))
    }
    if (delays.length) stop = clock.after(Math.min(...delays), () => {
      const before = latest?.members.map((member) => member.work)
      const next = project()
      latest = next
      if (JSON.stringify(before) !== JSON.stringify(next.members.map((member) => member.work))) changed(next)
      schedule()
    })
  }
  return {
    accept(view: CollaborationView): CollaborationView {
      const now = clock.nowMs(), live = new Set<string>()
      for (const member of view.members as readonly Member[]) {
        const key = keyOf(member), step = member.step
        if (view.status !== 'ready' || member.activity !== 'running' || !step) { states.delete(key); continue }
        live.add(key)
        const old = states.get(key)
        const area = step.phase === 'note' ? 'team' : step.tool ? workArea(kind(step.tool)) : null
        if (!old) states.set(key, { step, since: now, area, areaSince: now, focus: null, history: [] })
        else if (step.seq !== old.step.seq || step.phase !== old.step.phase || step.tool !== old.step.tool) {
          const nextArea = area ?? old.area
          if (nextArea !== old.area) {
            old.history.push({ area: old.area, start: old.areaSince, end: now })
            old.area = nextArea; old.areaSince = now
          }
          old.step = step; old.since = now
        }
      }
      for (const key of states.keys()) if (!live.has(key)) states.delete(key)
      latest = view
      latest = project(); schedule()
      return latest
    },
    reset() { stop?.(); stop = undefined; states.clear(); latest = undefined },
  }
}

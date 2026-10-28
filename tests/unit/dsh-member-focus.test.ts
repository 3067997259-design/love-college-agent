import { expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { createMemberFocus } from '../../src/main/dsh/member-focus'
import { toolKind, workArea } from '../../src/main/dsh/tool-kinds'
import type { AgentView, CollaborationView } from '../../src/shared/collaboration'
import type { DshMemberStep } from '../../src/shared/dsh-protocol'

const member: AgentView = { address: { runtimeId: 'r', projectId: 'p', rootSessionId: 'root', sessionId: 'child', parentSessionId: 'root' }, revision: 1,
  mode: 'teammate', name: 'helper', taskLabel: null, activity: 'running', outcome: 'none', waitingFor: null,
  controls: { message: true, interrupt: true }, usage: { admittedUnits: 0, inputTokens: null, outputTokens: null }, sources: { status: 'clean', kinds: [] }, error: null }
function fixture() {
  const clock = createManualClock(1000)
  let value: CollaborationView
  const focus = createMemberFocus(clock, (name) => toolKind(name, new Map()), (next) => { value = next })
  let seq = 0
  const accept = (tool: string | null, phase: DshMemberStep['phase'] = 'tool', patch: Partial<AgentView> = {}) => {
    const raw = { ...member, ...patch, step: { tool, phase, seq: ++seq }, activityLabel: 'RAW_TOOL' }
    value = focus.accept({ status: 'ready', runtimeId: 'r', projectId: 'p', tasks: [], members: [raw] })
    return value
  }
  return { clock, focus, accept, work: () => value.members[0].work, value: () => value }
}
it('uses the same tool vocabulary including bridge coordination and LCA overrides', () => {
  for (const name of ['spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']) expect(toolKind(name, new Map())).toBe('dsh.agent')
  expect(toolKind('read', new Map([['read', { templateId: 'document.read' }]]))).toBe('document.read')
  expect(toolKind('a-private-tool-name', new Map())).toBe('dsh.other')
  expect(workArea('dsh.shell')).toBe('files'); expect(workArea('dsh.skill')).toBe('research'); expect(workArea('dsh.plan')).toBe('team')
})
it('waits six seconds, ignores brief changes and uses a rolling thirty-second majority', () => {
  const f = fixture()
  f.accept('edit'); f.clock.advanceBy(5999); expect(f.work()?.focus).toBeNull()
  f.clock.advanceBy(1); expect(f.work()?.focus).toBe('files')
  f.accept('grep'); f.clock.advanceBy(3000); f.accept('write'); f.clock.advanceBy(20_000)
  expect(f.work()?.focus).toBe('files')
  f.accept('grep'); f.clock.advanceBy(6000); expect(f.work()?.focus).toBe('files')
  f.clock.advanceBy(10_000); expect(f.work()?.focus).toBe('research')
  expect(f.value().members[0].revision).toBe(1)
})
it('keeps an area across same-kind tools and short thinking, and marks thinking long only at 20 seconds', () => {
  const f = fixture()
  f.accept('read'); f.clock.advanceBy(3000); f.accept('edit'); f.clock.advanceBy(3000)
  expect(f.work()?.focus).toBe('files')
  f.accept('edit', 'thinking'); const since = f.work()?.sinceMs
  f.clock.advanceBy(19_999); expect(f.work()?.long).toBe(false)
  f.clock.advanceBy(1); expect(f.work()).toMatchObject({ phase: 'thinking', templateId: null, long: true, focus: 'files', sinceMs: since })
  f.accept(null, 'note'); expect(f.work()?.long).toBe(false)
  f.clock.advanceBy(16_000); expect(f.work()?.focus).toBe('team')
})
it('strips raw names, clears idle/removed members and cancels scheduled changes on reset', () => {
  const f = fixture()
  f.accept('secret-tool-name')
  expect(JSON.stringify(f.value())).not.toMatch(/secret-tool-name|RAW_TOOL|"step"|activityLabel/)
  f.accept('edit', 'tool', { activity: 'inactive' }); expect(f.work()).toBeNull()
  f.accept('edit'); f.focus.reset(); const before = f.value()
  f.clock.advanceBy(60_000); expect(f.value()).toBe(before)
})

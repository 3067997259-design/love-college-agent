import { expect, it } from 'vitest'
import { createWorkCollaboration } from '../../src/main/work/collaboration'
import type { AppCommand } from '../../src/shared'
import type { CollaborationPort } from '../../src/main/dsh/collaboration'

it('selects exact work families, retires closed generations and refuses late reads after switching', async () => {
  const calls: string[] = [], views = ['front', 'a', 'b']
  let release!: (value: { steps: []; withheld: false }) => void
  const port = (id: string): CollaborationPort => ({ view: () => ({ status: 'ready', runtimeId: id, projectId: id, members: [], tasks: [] }),
    dispatch: () => { calls.push(id); return undefined }, readMemberSteps: () => new Promise(done => { release = done }) })
  const router = createWorkCollaboration({ foreground: () => port('front'), works: () => views.slice(1).map(workId => ({ identity: { workId }, label: workId })), changed: () => {} })
  const select = (workId: string | null) => router.dispatch({ type: 'agent.refresh', workId } as AppCommand)
  const old = router.register('a', port('a')), removeB = router.register('b', port('b'))
  expect(select('missing')).toBe('invalid-command'); expect(router.view().runtimeId).toBe('front')
  expect(select('a')).toBeUndefined(); expect(calls).toEqual(['a'])
  const pending = router.readMemberSteps({ runtimeId: 'a', projectId: 'a', rootSessionId: 'root-a', sessionId: 'member', parentSessionId: 'root-a' })
  select('b'); release({ steps: [], withheld: false }); await expect(pending).rejects.toThrow('LCA_MEMBER_STEPS_UNAVAILABLE')
  const removeNew = router.register('a', port('a-new')); old(); select('a')
  expect(router.view().runtimeId).toBe('a-new')
  removeNew(); expect(router.view().status).toBe('unavailable'); expect(router.view().members).toEqual([])
  expect(router.view().workSelection?.choices.find(work => work.workId === 'a')?.available).toBe(false)
  select(null); expect(calls.at(-1)).toBe('front'); removeB()
})

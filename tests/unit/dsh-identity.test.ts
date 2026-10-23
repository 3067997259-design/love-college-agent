import { expect, it } from 'vitest'
import { createDshIdentities } from '../../src/main/dsh/identity'
import { createAppController } from '../../src/main/bridge/controller'
import { createManualClock } from '../../src/main/clock'

it('binds nested lineage, project and generation; only known ancestry is admitted', () => {
  const ids = createDshIdentities('runtime-a'), binding = ids.reserveRoot('root', 'project-a')
  const child = { ...binding, rootSessionId: 'root', sessionId: 'child', parentSessionId: 'root' }
  const grandchild = { ...child, sessionId: 'grandchild', parentSessionId: 'child' }
  expect(ids.register(grandchild)).toBeNull()
  expect(ids.register(child)).toEqual(child); expect(ids.register(grandchild)).toEqual(grandchild)
  for (const bad of [{ ...child, parentSessionId: 'grandchild' }, { ...child, cwd: 'project-b' }, { ...child, runtimeId: 'old' }, { ...child, protocolVersion: 1 }, { ...child, extra: 'raw transcript' }]) expect(ids.register(bad)).toBeNull()
  const address = ids.address('child')!
  expect(address).not.toHaveProperty('cwd'); expect(address).not.toHaveProperty('protocolVersion')
  address.projectId = 'tampered'; expect(ids.validate(child)).toEqual(child)
  const fresh = createDshIdentities('runtime-b'); fresh.reserveRoot('root', 'project-a')
  expect(fresh.register(child)).toBeNull()
  ids.forgetRoot('root'); expect(ids.validate(grandchild)).toBeNull()
})

it('rejects stale visible revisions, inactive projects and reset identities', () => {
  const ids = createDshIdentities(), a = ids.reserveRoot('root', 'project-a')
  const target = { address: ids.address('root')!, expectedRevision: 0 }
  expect(ids.acceptsTarget(target, a.projectId)).toBe(true)
  ids.setRevision('root', 2)
  expect(ids.acceptsTarget(target, a.projectId)).toBe(false)
  target.expectedRevision = 2
  expect(ids.acceptsTarget(target, a.projectId)).toBe(true)
  expect(ids.acceptsTarget(target, 'other-project')).toBe(false)
  expect(ids.setRevision('root', 1)).toBe(false)
  ids.clear(); expect(ids.acceptsTarget(target, a.projectId)).toBe(false)
})

it('keeps the new command vocabulary closed and unavailable until adapters are installed', () => {
  const controller = createAppController(createManualClock())
  const base = { protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: 'v12' }
  const ids = createDshIdentities(); ids.reserveRoot('root', 'project')
  const commands = [
    { type: 'extension.pick' }, { type: 'extension.install', proposalId: 'p', fingerprint: 'f' },
    { type: 'agent.interrupt', target: { address: ids.address('root'), expectedRevision: 0 } },
  ]
  for (const command of commands) {
    base.requestId = command.type
    expect(controller.dispatch({ ...base, ...command })).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    expect(controller.dispatch({ ...base, ...command, epoch: 'old' })).toMatchObject({ status: 'rejected', error: { code: 'stale-epoch' } })
    expect(controller.dispatch({ ...base, ...command, path: 'private' })).toMatchObject({ status: 'rejected', error: { code: 'invalid-command' } })
    expect(controller.dispatch({ ...base, ...command }, 'mini')).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } })
  }
  expect(controller.getSnapshot().collaboration).toBeUndefined()
  expect(controller.getSnapshot().extensions).toBeUndefined()
  controller.dispose()
})

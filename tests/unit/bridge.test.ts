import { describe, expect, it } from 'vitest'
import { createAppController } from '../../src/main/bridge/controller'
import { createManualClock } from '../../src/main/clock'
import type { AppEvent } from '../../src/shared'
import type { BackupService } from '../../src/main/backup/service'
import type { DiagnosticsView } from '../../src/shared'
import type { ExtensionsService } from '../../src/main/dsh/extensions'
import type { SkillsService } from '../../src/main/dsh/skills'

describe('public bridge controller', () => {
  it('keeps skill import/remove on the book with no renderer paths and deduplicates import clicks', () => {
    const controller = createAppController(createManualClock()); let calls = 0
    controller.attachSkills({ view: () => ({ status: 'ready', items: [], projectKey: 'project', operation: null, error: null }), dispatch: () => { calls++; return undefined } } as unknown as SkillsService)
    const input = { protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: 'skill-import', type: 'skills.import', scope: 'project' }
    for (const surface of ['mini', 'diagnostics'] as const) expect(controller.dispatch(input, surface).status).toBe('rejected')
    expect(controller.dispatch({ ...input, path: 'C:/arbitrary' }).status).toBe('rejected')
    expect(controller.dispatch({ ...input, scope: 'global' }).status).toBe('rejected')
    expect(controller.dispatch(input).status).toBe('accepted'); expect(controller.dispatch(input).status).toBe('accepted'); expect(calls).toBe(1)
  })
  it('routes only bounded book extension commands and deduplicates accepted requests', () => {
    const controller = createAppController(createManualClock()); let calls = 0
    controller.attachExtensions({ view: () => ({ status: 'ready', items: [], operations: [], proposal: null }), dispatch: () => { calls++; return undefined } } as unknown as ExtensionsService)
    const input = { protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: 'extension-refresh', type: 'extension.refresh' }
    expect(controller.dispatch({ ...input, requestId: 'debug' }, 'diagnostics').status).toBe('rejected')
    expect(controller.dispatch({ ...input, requestId: 'mini' }, 'mini').status).toBe('rejected')
    expect(controller.dispatch({ ...input, path: 'C:/arbitrary' }).status).toBe('rejected')
    expect(controller.dispatch(input).status).toBe('accepted'); expect(controller.dispatch(input).status).toBe('accepted')
    expect(calls).toBe(1); expect(controller.getSnapshot().extensions?.status).toBe('ready')
  })
  it('refuses diagnostics outside developer mode before invoking the reader', () => {
    const controller = createAppController(createManualClock()); let reads = 0
    controller.attachDiagnostics(() => { reads++; return {} as DiagnosticsView })
    expect(() => controller.readDiagnostics()).toThrow('DIAGNOSTICS_UNAVAILABLE'); expect(reads).toBe(0)
    controller.attachRuntime({ view: () => ({ plugins: [], developer: { mode: 'booth', requestedEnabled: false, restartRequired: false } }), dispatch: () => undefined })
    expect(() => controller.readDiagnostics()).toThrow('DIAGNOSTICS_UNAVAILABLE'); expect(reads).toBe(0)
    controller.attachRuntime({ view: () => ({ plugins: [], developer: { mode: 'developer', requestedEnabled: true, restartRequired: false } }), dispatch: () => undefined })
    controller.readDiagnostics(); expect(reads).toBe(1)
  })
  it('blocks new writes while a backup is active and still returns the original ack for a repeated request', () => {
    const controller = createAppController(createManualClock()); let busy = false
    const backup = { view: () => ({ status: 'idle' }), isBusy: () => busy, dispatch: () => { busy = true; return undefined } } as unknown as BackupService
    controller.attachBackup(backup)
    const command = { protocolVersion: 1, epoch: controller.getSnapshot().epoch, requestId: 'backup-request', type: 'backup.export' }
    expect(controller.dispatch(command).status).toBe('accepted'); expect(controller.dispatch(command).status).toBe('accepted')
    expect(controller.dispatch({ ...command, requestId: 'new-request', type: 'mode.set', mode: 'work' })).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    expect(controller.getSnapshot().companion.mode).toBe('rest')
  })
  it('rejects malformed, undeveloped and stale commands without pretending work completed', () => {
    const controller = createAppController(createManualClock())
    const base = { protocolVersion: 1, requestId: 'r1', epoch: controller.getSnapshot().epoch }
    expect(controller.dispatch({ ...base, type: 'shell.exec', command: 'anything' })).toMatchObject({ status: 'rejected', error: { code: 'invalid-command' } })
    expect(controller.dispatch({ ...base, type: 'mode.set', mode: 'rest', secret: 'must-not-reflect' })).toMatchObject({ status: 'rejected' })
    expect(controller.dispatch({ ...base, type: 'message.send', text: 'hello' })).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    expect(controller.dispatch({ ...base, requestId: 'r2', type: 'privacy.set', enabled: true })).toMatchObject({ status: 'rejected', error: { code: 'privacy-unavailable' } })
    expect(controller.dispatch({ ...base, epoch: 'old', type: 'lights.set', lightsOut: true })).toMatchObject({ status: 'rejected', error: { code: 'stale-epoch' } })
    expect(controller.getSnapshot().messages).toEqual([])
  })
  it('keeps collaboration commands book-only, closed-schema and deduplicated', () => {
    const controller = createAppController(createManualClock()); let calls = 0
    controller.attachCollaboration({ view: () => ({ status: 'unavailable', runtimeId: null, projectId: null, members: [], tasks: [] }), dispatch: () => { calls++; return undefined } })
    const command = { protocolVersion: 1, requestId: 'collaboration-refresh', epoch: controller.getSnapshot().epoch, type: 'agent.refresh' }
    expect(controller.dispatch(command, 'mini').status).toBe('rejected')
    expect(controller.dispatch({ ...command, path: 'arbitrary' }).status).toBe('rejected')
    expect(controller.dispatch(command).status).toBe('accepted')
    expect(controller.dispatch(command).status).toBe('accepted')
    expect(calls).toBe(1)
  })
  it('deduplicates commands, publishes ordered immutable snapshots, and unsubscribes', () => {
    const clock = createManualClock()
    const controller = createAppController(clock)
    const events: AppEvent[] = []
    const stop = controller.subscribe((event) => events.push(event))
    const command = { protocolVersion: 1, requestId: 'r1', epoch: controller.getSnapshot().epoch, type: 'mode.set', mode: 'quiet' }
    expect(controller.dispatch(command).status).toBe('accepted')
    expect(controller.dispatch(command).status).toBe('accepted')
    expect(events).toHaveLength(1)
    controller.start()
    clock.advanceBy(1000)
    expect(events.map((event) => event.revision)).toEqual([1, 2])
    expect(events[0].snapshot.clock.nowMs).toBe(0)
    stop()
    clock.advanceBy(1000)
    expect(events).toHaveLength(2)
    const copy = controller.getSnapshot()
    copy.companion.mode = 'work'
    expect(controller.getSnapshot().companion.mode).toBe('quiet')
    controller.dispose()
    clock.advanceBy(5000)
    expect(controller.getSnapshot().clock.nowMs).toBe(2000)
  })
})

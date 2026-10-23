import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createExtensions, type ExtensionRuntime, type ExtensionTransport } from '../../src/main/dsh/extensions'
import { createManualClock } from '../../src/main/clock'
import type { AppCommand } from '../../src/shared'
import type { DshExtensionReply, DshExtensionRequest } from '../../src/shared/dsh-extensions'

const command = (body: Record<string, unknown>) => ({ protocolVersion: 1, epoch: 'test', requestId: randomUUID(), ...body }) as AppCommand
const deferred = <T>() => { let done!: (value: T) => void; const promise = new Promise<T>((resolve) => { done = resolve }); return { promise, done } }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function setup(approve: (input: { id: string; question: string; signal: AbortSignal }) => Promise<boolean> = async () => true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lca-extensions-unit-')), candidate = join(dataDir, 'candidate'); mkdirSync(candidate)
  writeFileSync(join(candidate, 'package.json'), JSON.stringify({ name: 'unit-fixture', version: '1.0.0', dsh: { bundle: { patch: 'patch.yml' } } }))
  writeFileSync(join(candidate, 'patch.yml'), '[]')
  let reply: DshExtensionReply = { items: [{ name: 'unit-fixture', version: '1.0.0', installed: true, builtin: false, enabled: false, applied: 'disabled', protected: false, fingerprint: 'fingerprint', restartRequired: false }] }
  const extensions = vi.fn(async (input: DshExtensionRequest): Promise<DshExtensionReply> => ({ ...reply, ...(input.action === 'list' ? {} : { operation: { operationId: input.operationId, outcome: 'succeeded', restartRequired: false } }) }))
  const host: ExtensionTransport = { extensions }, clock = createManualClock()
  const withRuntime = async <T>(job: (runtime: ExtensionRuntime) => Promise<T>) => job({ host, restart: async () => host })
  const approvals = vi.fn(approve)
  const options = { dataDir, clock, choose: async () => candidate, withRuntime, approve: approvals, changed: () => {} }
  const service = createExtensions(options)
  const run = async (body: Record<string, unknown>) => { const input = command(body); expect(service.dispatch(input)).toBeUndefined(); await service.idle(); return input }
  const change = (type = 'extension.enable') => { const item = service.view().items[0]; return command({ type, extensionId: item.id, expectedRevision: item.revision, fingerprint: item.source.fingerprint }) }
  return { dataDir, candidate, service, options, run, change, extensions, approvals, clock, setReply: (next: DshExtensionReply) => { reply = next } }
}

it('requires exact approval, never trusts project state, and rejects protected or stale UI requests', async () => {
  const f = setup(async () => false); await f.run({ type: 'extension.refresh' })
  const input = f.change(); expect(f.service.dispatch(input)).toBeUndefined(); await f.service.idle()
  expect(f.approvals).toHaveBeenCalledOnce(); expect(f.extensions.mock.calls.every(([input]) => input.action === 'list')).toBe(true)
  expect(f.service.view().operations.at(-1)?.outcome).toBe('cancelled')
  expect(f.service.dispatch({ ...f.change(), expectedRevision: 999 } as AppCommand)).toBe('stale-candidate')
  f.setReply({ items: [{ name: 'core', version: null, installed: true, builtin: true, enabled: true, applied: 'ready', protected: true, fingerprint: 'p', restartRequired: false }] })
  await f.run({ type: 'extension.refresh' }); expect(f.service.dispatch(f.change())).toBe('permission-denied')
})

it('cancels a pending approval and ignores its late allow answer without executing', async () => {
  const answer = deferred<boolean>(), f = setup(() => answer.promise); await f.run({ type: 'extension.refresh' })
  f.service.dispatch(f.change()); await flush()
  const operation = f.service.view().operations.at(-1)!
  expect(f.service.dispatch(command({ type: 'extension.cancel', operationId: operation.id, expectedRevision: operation.revision }))).toBeUndefined()
  answer.done(true); await f.service.idle()
  expect(f.service.view().operations.at(-1)?.outcome).toBe('cancelled')
  expect(f.extensions.mock.calls.some(([input]) => input.action === 'enable')).toBe(false)
})

it('revalidates displayed state before asking, then binds the approved fingerprint to the mutation', async () => {
  const f = setup(); await f.run({ type: 'extension.refresh' }); const input = f.change()
  f.setReply({ items: [{ ...f.service.view().items[0], name: 'unit-fixture', version: '2.0.0', installed: true, builtin: false, enabled: false, applied: 'disabled', protected: false, fingerprint: 'changed', restartRequired: false }] })
  f.service.dispatch(input); await f.service.idle()
  expect(f.approvals).not.toHaveBeenCalled(); expect(f.service.view().operations.at(-1)?.error?.code).toBe('stale-candidate')
})

it('stages local sources and rejects a changed candidate after approval', async () => {
  const answer = deferred<boolean>(), f = setup(() => answer.promise)
  await f.run({ type: 'extension.pick' }); const proposal = f.service.view().proposal!
  f.service.dispatch(command({ type: 'extension.install', proposalId: proposal.id, fingerprint: proposal.fingerprint })); await flush()
  writeFileSync(join(f.dataDir, 'extension-candidates', proposal.id, 'patch.yml'), 'changed')
  answer.done(true); await f.service.idle()
  expect(f.service.view().operations.at(-1)?.error?.code).toBe('stale-candidate')
  expect(f.extensions.mock.calls.some(([input]) => input.action === 'install')).toBe(false)
  expect(JSON.stringify(f.service.view())).not.toContain(f.dataDir)
})

it('persists unknown outcomes across cold recovery and reconciles the original id without replay', async () => {
  const f = setup(); await f.run({ type: 'extension.refresh' }); const input = f.change()
  f.extensions.mockImplementation(async (request) => { if (request.action === 'enable') throw new Error('disconnected'); return { items: [], operation: request.action === 'reconcile' ? { operationId: request.operationId, outcome: 'succeeded', restartRequired: true } : undefined } })
  // Retain a valid preflight list, then lose the mutation reply.
  f.extensions.mockResolvedValueOnce({ items: [{ name: 'unit-fixture', version: '1.0.0', installed: true, builtin: false, enabled: false, applied: 'disabled', protected: false, fingerprint: 'fingerprint', restartRequired: false }] })
  f.service.dispatch(input); await f.service.idle(); expect(f.service.view().operations.at(-1)?.outcome).toBe('unknown')
  f.service.close(); const recovered = createExtensions(f.options)
  expect(recovered.dispatch(input)).toBeUndefined(); await recovered.idle()
  const operation = recovered.view().operations.at(-1)!
  recovered.dispatch(command({ type: 'extension.reconcile', operationId: operation.id, expectedRevision: operation.revision })); await recovered.idle()
  expect(recovered.view().operations.at(-1)?.outcome).toBe('succeeded')
  expect(f.extensions.mock.calls.filter(([input]) => input.action === 'enable')).toHaveLength(1)
  expect(f.extensions.mock.calls.at(-1)?.[0]).toEqual({ action: 'reconcile', operationId: operation.id })
})

it('cancellation observes an operation that finished too late instead of pretending to roll it back', async () => {
  const f = setup(); await f.run({ type: 'extension.refresh' })
  const result = deferred<DshExtensionReply>(); let operationId = ''
  f.extensions.mockImplementation(async (input) => {
    if (input.action === 'list') return { items: [{ name: 'unit-fixture', version: '1.0.0', installed: true, builtin: false, enabled: false, applied: 'disabled', protected: false, fingerprint: 'fingerprint', restartRequired: false }] }
    operationId = input.operationId
    if (input.action === 'enable') return result.promise
    return { items: [], operation: { operationId, outcome: 'succeeded', restartRequired: true } }
  })
  f.service.dispatch(f.change()); await flush(); const operation = f.service.view().operations.at(-1)!
  f.service.dispatch(command({ type: 'extension.cancel', operationId: operation.id, expectedRevision: operation.revision })); await flush()
  result.done({ items: [], operation: { operationId, outcome: 'succeeded', restartRequired: true } }); await f.service.idle()
  expect(f.service.view().operations.at(-1)).toMatchObject({ outcome: 'succeeded', restartRequired: true })
})

it('times out by cancelling the same operation, never by repeating a mutation', async () => {
  const f = setup(); await f.run({ type: 'extension.refresh' }); const input = f.change()
  const response = deferred<DshExtensionReply>()
  f.extensions.mockResolvedValueOnce({ items: [{ name: 'unit-fixture', version: '1.0.0', installed: true, builtin: false, enabled: false, applied: 'disabled', protected: false, fingerprint: 'fingerprint', restartRequired: false }] })
  f.extensions.mockImplementation(async (request) => {
    if (request.action === 'enable') return response.promise
    const reply: DshExtensionReply = { items: [], operation: { operationId: request.action === 'list' ? '' : request.operationId, outcome: 'cancelled', restartRequired: false } }; response.done(reply); return reply
  })
  f.service.dispatch(input); await flush(); f.clock.advanceBy(600_000); await f.service.idle()
  expect(f.service.view().operations.at(-1)?.outcome).toBe('cancelled')
  expect(f.extensions.mock.calls.filter(([input]) => input.action === 'enable')).toHaveLength(1)
  expect(f.extensions.mock.calls.at(-1)?.[0].action).toBe('cancel')
})

it('cold startup never resumes an old approval and corrupt ledgers fail closed', () => {
  const f = setup(), file = join(f.dataDir, 'extensions.json')
  const ledger = JSON.parse(readFileSync(file, 'utf8')); ledger.operations.push({ id: 'x', phase: 'awaiting-approval', outcome: 'pending', revision: 1 })
  writeFileSync(file, JSON.stringify(ledger)); const recovered = createExtensions(f.options)
  expect(recovered.view().operations[0]).toMatchObject({ outcome: 'cancelled', cancellable: false }); expect(f.approvals).not.toHaveBeenCalled()
  writeFileSync(file, '{ broken'); expect(() => createExtensions(f.options)).toThrow()
})

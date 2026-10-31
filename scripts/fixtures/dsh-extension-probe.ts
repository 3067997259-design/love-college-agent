import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { startDshHost, prepareDshProfile, type DshHost } from '../../src/main/dsh/host'
import { createExtensions } from '../../src/main/dsh/extensions'
import { systemClock } from '../../src/main/clock'
import type { AppCommand } from '../../src/shared'

const [, , root, repo] = process.argv
if (!root || !repo) throw new Error('isolated root required')
const user = join(root, 'user'), dataDir = join(root, 'data'), workspace = join(root, 'work')
for (const dir of [user, dataDir, workspace, join(user, 'AppData', 'Roaming'), join(user, 'AppData', 'Local')]) mkdirSync(dir, { recursive: true })
const electron = process.argv.includes('--electron')
if (electron) { process.env.Path = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` }
Object.assign(process.env, { USERPROFILE: user, HOME: user, APPDATA: join(user, 'AppData', 'Roaming'), LOCALAPPDATA: join(user, 'AppData', 'Local'), LCA_DSH_NODE: process.execPath })
const options = { clock: systemClock, dshRoot: join(repo, 'dsh', 'runtime'), bridge: join(repo, 'dsh', 'lca-bridge'), dataDir, workspace, routes: null, guardedRoots: [dataDir], persona: '', tools: [], onEvent: (event: { t: string; [key: string]: unknown }) => { if (event.t === 'error') console.error(event) }, onCall: async () => { throw new Error('No model tools allowed') }, onApproval: async () => 'rejected' as const }
const { profile, home } = prepareDshProfile(options)
writeFileSync(join(profile, '.npmrc'), 'registry=http://127.0.0.1:9/\nfetch-retries=0\nmanage-package-manager-versions=false\n')
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')); manifest.lcaProbe = { preserved: true }
writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
const fixture = mkdtempSync(join(root, 'bundle-')), name = 'lca-synthetic-fixture'
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
writeFileSync(join(fixture, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: `${name}:marker`, name }] }]))
writeFileSync(join(fixture, 'index.js'), `import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export function apply(){writeFileSync(join(process.env.DSH_HOME,'extension-activated.txt'),'active')}\n`)
let dropNextReceipt = false, disconnectedAfterReceipt = false
const originalSpawn = childProcess.spawn
childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
  const child = originalSpawn(...args)
  // Test-only transport fault: the subprocess has durably finished, but its IPC reply never reaches main.
  const emit = child.emit.bind(child)
  child.emit = ((event: string, ...values: unknown[]) => {
    const message = values[0] as { t?: string; value?: { operation?: { outcome?: string } } } | undefined
    if (event === 'message' && dropNextReceipt && message?.t === 'extensions' && message.value?.operation?.outcome === 'succeeded') {
      dropNextReceipt = false; disconnectedAfterReceipt = true; child.disconnect(); return true
    }
    return emit(event, ...values)
  }) as typeof child.emit
  return child
}) as typeof childProcess.spawn
syncBuiltinESMExports()
let host: DshHost | undefined, chosen: string | null = fixture
const receipts: Record<string, unknown>[] = [], approvals: string[] = []
const start = async () => { host = startDshHost(options); await host.started; return host }
const restart = async () => { await host?.close(); host = undefined; return start() }
const serviceOptions = { dataDir, clock: systemClock, choose: async () => chosen,
  withRuntime: async <T>(job: (runtime: import('../../src/main/dsh/extensions').ExtensionRuntime) => Promise<T>) => { try { return await job({ host: host?.available() ? host : await start(), restart }) } catch (error) { if (!disconnectedAfterReceipt) console.error('PROBE_RUNTIME_FAILED', error); throw error } },
  approve: async ({ question }: { question: string; id: string; signal: AbortSignal }) => { approvals.push(question); return true }, changed: () => {} }
let service = createExtensions(serviceOptions)
const command = (body: Record<string, unknown>) => ({ protocolVersion: 1, epoch: 'probe', requestId: randomUUID(), ...body }) as AppCommand
const run = async (body: Record<string, unknown>) => { const input = command(body); assert.equal(service.dispatch(input), undefined); await service.idle(); return input }
const viewItem = () => service.view().items.find((item) => item.id === name)!
const change = async (type: string) => { const item = viewItem(); return run({ type, extensionId: item.id, expectedRevision: item.revision, fingerprint: item.source.fingerprint }) }
const last = () => service.view().operations.at(-1)!
const record = (check: string) => receipts.push({ check, outcome: last()?.outcome, items: service.view().items.filter((item) => item.id === name) })
const timeout = setTimeout(() => { console.error('EXTENSION_PROBE_TIMEOUT', root); void host?.close(); process.exitCode = 1 }, 180_000)
try {
  await run({ type: 'extension.refresh' })
  const base = service.view().items.find((item) => item.id === '@deepseek-ai/dsh-base')!
  assert.ok(base.protected)
  assert.equal(service.dispatch(command({ type: 'extension.disable', extensionId: base.id, expectedRevision: base.revision, fingerprint: base.source.fingerprint })), 'permission-denied')
  await run({ type: 'extension.pick' }); const proposal = service.view().proposal!
  assert.ok(proposal)
  const install = await run({ type: 'extension.install', proposalId: proposal.id, fingerprint: proposal.fingerprint })
  assert.equal(last().outcome, 'succeeded', JSON.stringify(last())); assert.equal(viewItem().enabledIntent, false)
  assert.equal(existsSync(join(home, 'extension-activated.txt')), false)
  const count = service.view().operations.length
  assert.equal(service.dispatch(install), undefined); await service.idle(); assert.equal(service.view().operations.length, count)
  record('install-disabled-and-deduplicate')
  await change('extension.enable'); assert.equal(last().outcome, 'succeeded'); assert.equal(viewItem().restartReason, 'enablement'); assert.equal(viewItem().applied, 'disabled')
  await run({ type: 'extension.restart' }); assert.equal(last().outcome, 'succeeded'); assert.equal(viewItem().applied, 'ready'); assert.ok(existsSync(join(home, 'extension-activated.txt'))); record('enable-restart-actual-module-loaded')
  await change('extension.remove'); assert.equal(last().outcome, 'failed'); record('refuse-removal-of-running-code')
  await change('extension.disable'); assert.equal(viewItem().applied, 'ready'); assert.equal(viewItem().enabledIntent, false)
  await run({ type: 'extension.restart' }); assert.equal(viewItem().applied, 'disabled'); record('disable-persists-across-cold-start')
  await change('extension.remove'); assert.equal(last().outcome, 'succeeded', JSON.stringify(last())); assert.equal(service.view().items.some((item) => item.id === name), false)
  await run({ type: 'extension.restart' }); assert.equal(service.view().items.some((item) => item.id === name), false)
  assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).lcaProbe.preserved, true); record('remove-restart-preserves-user-configuration')
  // A local dependency with a postinstall script must fail closed, ask separately, and leave no standing grant.
  const built = mkdtempSync(join(root, 'build-bundle-')), buildName = 'lca-build-fixture'
  writeFileSync(join(built, 'package.json'), JSON.stringify({ name: buildName, version: '1.0.0', type: 'module', main: './index.js', scripts: { postinstall: 'build.cmd' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(built, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(built, 'index.js'), 'export function apply(){}\n')
  writeFileSync(join(built, 'build.cmd'), '@echo off\r\necho approved-build>built.txt\r\n')
  chosen = built; await run({ type: 'extension.pick' }); const buildProposal = service.view().proposal!
  const policyBefore = readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), approvalsBefore = approvals.length
  await run({ type: 'extension.install', proposalId: buildProposal.id, fingerprint: buildProposal.fingerprint })
  assert.equal(last().outcome, 'succeeded', JSON.stringify(last()))
  assert.equal(approvals.length - approvalsBefore, 2, 'installation and exact build scripts require separate approval')
  assert.ok(existsSync(join(profile, 'node_modules', buildName, 'built.txt')))
  assert.equal(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), policyBefore)
  receipts.push({ check: 'separate-build-approval-without-standing-grant', outcome: last().outcome })
  // A genuinely running build is cancelled through the same operation id, then the profile is reconciled.
  const slow = mkdtempSync(join(root, 'slow-bundle-')), slowName = 'lca-slow-fixture', startedFile = join(root, 'slow-started.txt')
  writeFileSync(join(slow, 'package.json'), JSON.stringify({ name: slowName, version: '1.0.0', type: 'module', main: './index.js', scripts: { postinstall: 'build.cmd' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(slow, 'cordis.patch.yml'), '[]\n'); writeFileSync(join(slow, 'index.js'), 'export function apply(){}\n')
  writeFileSync(join(slow, 'build.cmd'), `@echo off\r\necho started>"${startedFile}"\r\nping -t 127.0.0.1 > nul\r\n`)
  chosen = slow; await run({ type: 'extension.pick' }); const slowProposal = service.view().proposal!
  assert.equal(service.dispatch(command({ type: 'extension.install', proposalId: slowProposal.id, fingerprint: slowProposal.fingerprint })), undefined)
  for (let tick = 0; tick < 600 && !existsSync(startedFile) && service.busy(); tick++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(existsSync(startedFile), JSON.stringify(last()))
  const pending = last(); assert.equal(pending.outcome, 'pending')
  assert.equal(service.dispatch(command({ type: 'extension.cancel', operationId: pending.id, expectedRevision: pending.revision })), undefined)
  await service.idle(); assert.equal(last().outcome, 'cancelled', JSON.stringify(last()))
  assert.equal(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), policyBefore)
  assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies[slowName], undefined)
  receipts.push({ check: 'cancel-running-build-and-observe-restoration', outcome: last().outcome })
  // Lose an installation receipt, restart main + DSH, and reconcile the exact id without reinstalling.
  chosen = fixture; await run({ type: 'extension.pick' }); const lostProposal = service.view().proposal!
  dropNextReceipt = true
  const lostCommand = await run({ type: 'extension.install', proposalId: lostProposal.id, fingerprint: lostProposal.fingerprint })
  assert.ok(disconnectedAfterReceipt); assert.equal(last().outcome, 'unknown')
  const lostId = last().id, diskCount = Object.keys(JSON.parse(readFileSync(join(profile, 'lca-extension-operations.json'), 'utf8')).operations).length
  await host?.close(); host = undefined; service.close(); service = createExtensions(serviceOptions)
  assert.equal(service.dispatch(lostCommand), undefined); await service.idle()
  const lost = last(); assert.equal(lost.id, lostId)
  await run({ type: 'extension.reconcile', operationId: lost.id, expectedRevision: lost.revision })
  assert.equal(last().outcome, 'succeeded'); assert.equal(viewItem().installation, 'installed')
  assert.equal(Object.keys(JSON.parse(readFileSync(join(profile, 'lca-extension-operations.json'), 'utf8')).operations).length, diskCount)
  receipts.push({ check: 'lost-ipc-receipt-cold-main-dsh-reconcile-without-replay', outcome: last().outcome })
  // A bundle's declarative layer may add its own entries, but cannot turn off safety rows.
  const override = mkdtempSync(join(root, 'override-bundle-'))
  writeFileSync(join(override, 'package.json'), JSON.stringify({ name: 'lca-override-fixture', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(override, 'cordis.patch.yml'), JSON.stringify([{ id: 'permission', disabled: true }]))
  chosen = override; await run({ type: 'extension.pick' }); const forbidden = service.view().proposal!
  await run({ type: 'extension.install', proposalId: forbidden.id, fingerprint: forbidden.fingerprint })
  assert.equal(last().error?.code, 'permission-denied')
  assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies['lca-override-fixture'], undefined)
  receipts.push({ check: 'bundle-cannot-override-safety-rows', outcome: 'refused' })
  // A loaded layer is not sufficient evidence of activation: inspect actual plugin fibers.
  const failed = mkdtempSync(join(root, 'failed-bundle-')), failedName = 'lca-failing-fixture'
  writeFileSync(join(failed, 'package.json'), JSON.stringify({ name: failedName, version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(failed, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: `${failedName}:broken`, name: failedName }] }]))
  writeFileSync(join(failed, 'index.js'), "export function apply(){throw new Error('synthetic activation failure')}\n")
  chosen = failed; await run({ type: 'extension.pick' }); const failedProposal = service.view().proposal!
  await run({ type: 'extension.install', proposalId: failedProposal.id, fingerprint: failedProposal.fingerprint }); assert.equal(last().outcome, 'succeeded')
  const failedItem = service.view().items.find((item) => item.id === failedName)!
  await run({ type: 'extension.enable', extensionId: failedName, expectedRevision: failedItem.revision, fingerprint: failedItem.source.fingerprint })
  await run({ type: 'extension.restart' })
  assert.notEqual(service.view().items.find((item) => item.id === failedName)!.applied, 'ready')
  receipts.push({ check: 'activation-failure-never-shown-ready', outcome: service.view().items.find((item) => item.id === failedName)!.applied })
  // Direct management IPC also protects core bundles independently of UI validation.
  const currentBase = service.view().items.find((item) => item.id === '@deepseek-ai/dsh-base')!
  const denied = await host!.extensions({ action: 'disable', target: currentBase.id, fingerprint: currentBase.source.fingerprint, operationId: randomUUID() })
  assert.equal(denied.operation?.error, 'protected'); receipts.push({ check: 'protected-core-at-runtime-port', outcome: 'refused' })
  chosen = null
  const evidence = { receipts, approvals: approvals.length, runtime: '0.2.1-rc.2', pnpm: JSON.parse(readFileSync(join(repo, 'dsh/runtime/node_modules/pnpm/package.json'), 'utf8')).version,
    bridgeHash: createHash('sha256').update(readFileSync(join(repo, 'dsh/lca-bridge/extensions.js'))).digest('hex'), modelRequests: 0, electron, systemNodeAndPnpmOnPath: !electron }
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ root, checks: receipts.map((entry) => entry.check), approvals: approvals.length, modelRequests: 0, electron, systemNodeAndPnpmOnPath: !electron }, null, 2))
} finally { clearTimeout(timeout); service.close(); await host?.close() }

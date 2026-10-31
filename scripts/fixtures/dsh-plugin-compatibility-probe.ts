import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createExtensions } from '../../src/main/dsh/extensions'
import { createManualClock } from '../../src/main/clock'
import { createExtensionAdapter } from '../../dsh/lca-bridge/extensions.js'
import { fingerprintDirectory } from '../../dsh/lca-bridge/extension-files.js'
import { sourceOf, gatedWhileDegraded, handoffOf } from '../../dsh/lca-bridge/policy.js'
import type { AppCommand } from '../../src/shared'

type Sample = { id: string; manifestText: string; expected: string; patch?: { path: string; text: string } }

export async function probe(root: string, repo: string, samples: Sample[]) {
  const checks: Record<string, unknown>[] = []
  const previousPnpm = process.env.LCA_PNPM_CLI
  process.env.LCA_PNPM_CLI = join(repo, 'dsh/runtime/node_modules/pnpm/bin/pnpm.cjs')
  let installCalls = 0
  const candidate = (id: string, manifestText: string, patch?: Sample['patch']) => {
    const dir = join(root, 'candidates', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), manifestText)
    if (patch) writeFileSync(join(dir, patch.path), patch.text)
    return dir
  }
  const select = async (id: string, dir: string) => {
    const service = createExtensions({ dataDir: join(root, 'selection', id), clock: createManualClock(),
      choose: async () => dir, changed() {},
      approve: async () => { throw new Error('Selection must not ask for installation approval') },
      withRuntime: async () => { throw new Error('Selection must not start a runtime') },
    })
    try {
      assert.equal(service.dispatch({ protocolVersion: 1, epoch: 'metadata-audit', requestId: randomUUID(), type: 'extension.pick' } as AppCommand), undefined)
      await service.idle()
      const view = service.view()
      return { status: view.status, proposal: view.proposal !== null }
    } finally { service.close() }
  }
  const admission = async (id: string, dir: string) => {
    const profile = join(root, 'profiles', id)
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'metadata-audit-profile', private: true }))
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    const before = installCalls
    const adapter = createExtensionAdapter({ profileContext: { dir: profile, startedBundles: [] }, pluginManager: {
      listPlugins: async () => [], listBundles: async () => [],
      // Deliberately stop at the first package-manager boundary: never report this as installation success.
      installBundle: async () => { installCalls++; throw new Error('AUDIT_STOP_BEFORE_INSTALL') },
    } })
    const reply = await adapter.request({ action: 'install', operationId: randomUUID(), spec: `file:${dir}`, fingerprint: fingerprintDirectory(dir) })
    return { outcome: reply.operation?.outcome, error: reply.operation?.error, reachedInstallBoundary: installCalls > before }
  }
  try {
    for (const sample of samples) {
      const dir = candidate(sample.id, sample.manifestText, sample.patch)
      const selection = await select(sample.id, dir)
      if (sample.expected === 'manifest-rejected') {
        assert.equal(selection.status, 'failed'); assert.equal(selection.proposal, false)
        checks.push({ sample: sample.id, check: 'original-manifest', selection, observed: 'manifest-rejected' })
      } else {
        assert.equal(selection.proposal, true)
        const result = await admission(sample.id, dir)
        assert.equal(result.error, 'protected'); assert.equal(result.reachedInstallBoundary, false)
        checks.push({ sample: sample.id, check: 'original-patch', selection, ...result, observed: 'patch-protected' })
        // Diagnostic only: changing a row id may break references. This is not an adapter or publishable package.
        const name = JSON.parse(sample.manifestText).name as string
        const normalized = candidate(`${sample.id}-row-only`, sample.manifestText, { path: 'cordis.patch.yml',
          text: JSON.stringify([{ insert: [{ id: `${name}:audit`, name }] }]) })
        const normalizedResult = await admission(`${sample.id}-row-only`, normalized)
        assert.equal(normalizedResult.reachedInstallBoundary, true)
        assert.equal(normalizedResult.outcome, 'failed')
        checks.push({ sample: sample.id, check: 'diagnostic-row-only-normalization', ...normalizedResult,
          observed: 'passed-patch-check-stopped-before-install', notCompatibilityAcceptance: true })
      }
    }
    const name = 'lca-metadata-control'
    const manifest = JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    const control = candidate('protected-row-control', manifest, { path: 'cordis.patch.yml', text: JSON.stringify([{ id: 'lca-bridge', disabled: true }]) })
    const result = await admission('protected-row-control', control)
    assert.equal(result.error, 'protected'); assert.equal(result.reachedInstallBoundary, false)
    checks.push({ sample: name, check: 'core-row-edit-remains-blocked', ...result })
    assert.equal(installCalls, 2)
    const policyObservations = ['web_search', 'mcp__search', 'find_dsh_plugin', 'pet_cua_click'].map(name => ({
      name, source: sourceOf(name), approvalWhenThirdPartyContext: gatedWhileDegraded(name), handoff: handoffOf(name),
    }))
    // Pure name classification only. No assertion about the full runtime authorization of an uninstalled tool.
    return { checks, policyObservations, modelRequests: 0, packageManagerRuns: 0, mockInstallBoundaryCalls: installCalls, thirdPartyCodeExecuted: false }
  } finally {
    if (previousPnpm === undefined) delete process.env.LCA_PNPM_CLI
    else process.env.LCA_PNPM_CLI = previousPnpm
  }
}

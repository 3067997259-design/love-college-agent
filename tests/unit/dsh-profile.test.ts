import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { prepareDshProfile as mainPrepare } from '../../src/main/dsh/host'
import { dshCli, prepareDshProfile } from '../../dsh/lca-bridge/profile.js'

it.skipIf(process.platform !== 'win32')('repairs a lowercased Windows launch without changing user profile layers', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'LCA-Profile-Case-')), bridge = join(dataDir, 'ExternalBridge')
  const runtime = join(dataDir, 'Runtime'), cliDir = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(bridge); mkdirSync(cliDir, { recursive: true }); writeFileSync(join(cliDir, 'bin.js'), '// fixture')
  const input = { dataDir: dataDir.toLowerCase(), dshRoot: runtime.toLowerCase(), bridge: bridge.toLowerCase() }
  const initial = prepareDshProfile(input), file = join(initial.profile, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.dependencies['@lca/dsh-bridge'] = `link:${bridge.toLowerCase().replaceAll('\\', '/')}`
  manifest.dsh.profile.bundles.splice(1, 0, 'user-layer'); manifest.userSetting = { keep: true }
  writeFileSync(file, JSON.stringify(manifest))
  const repaired = prepareDshProfile(input), after = JSON.parse(readFileSync(file, 'utf8'))
  expect(repaired.home).toBe(realpathSync.native(join(dataDir, 'dsh-home')))
  expect(repaired.profile).toBe(realpathSync.native(initial.profile))
  expect(repaired.cli).toBe(realpathSync.native(join(cliDir, 'bin.js')))
  expect(dshCli(runtime.toLowerCase())).toBe(repaired.cli)
  expect(after.dependencies['@lca/dsh-bridge']).toBe(`link:${realpathSync.native(bridge).replaceAll('\\', '/')}`)
  expect(realpathSync.native(readlinkSync(join(repaired.profile, 'node_modules', '@lca', 'dsh-bridge')))).toBe(realpathSync.native(bridge))
  expect(after.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'user-layer', '@lca/dsh-bridge'])
  expect(after.userSetting).toEqual({ keep: true })
})

it('shares migration rules, preserves disabled selections and user settings, and backs up exact input', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lca-profile-test-')), bridge = join(dataDir, 'bridge'); mkdirSync(bridge)
  const input = { dataDir, dshRoot: dataDir, bridge }, { profile } = prepareDshProfile(input)
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  manifest.dependencies.fixture = 'file:fixture'; manifest.userSetting = { keep: true }; manifest.dsh.profile.keep = 17
  const text = JSON.stringify(manifest)
  writeFileSync(join(profile, 'package.json'), text); writeFileSync(join(profile, 'cordis.patch.yml'), '# user config\n[]\n')
  mainPrepare(input)
  const after = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  expect(after.dependencies.fixture).toBe('file:fixture'); expect(after.userSetting.keep).toBe(true)
  expect(after.dsh.profile).toEqual({ keep: 17, bundles: ['@deepseek-ai/dsh-base', '@lca/dsh-bridge'] })
  expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('# user config\n[]\n')
  expect(prepareDshProfile(input)).toEqual(mainPrepare(input))
  writeFileSync(join(profile, 'package.json'), '{ broken')
  expect(() => mainPrepare(input)).toThrow(); expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe('{ broken')
})

it('restores temporary script permissions after a cold crash and refuses a still-running writer', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lca-profile-test-')), bridge = join(dataDir, 'bridge'); mkdirSync(bridge)
  const input = { dataDir, dshRoot: dataDir, bridge }, { profile } = prepareDshProfile(input)
  const file = join(profile, 'lca-extension-operations.json')
  const journal = { version: 1, operations: { op: { signature: 's', hostPid: process.pid, workspaceBefore: 'allowBuilds: {}\n', result: { outcome: 'pending' } } } }
  writeFileSync(file, JSON.stringify(journal)); expect(() => prepareDshProfile(input)).toThrow('STILL_RUNNING')
  journal.operations.op.hostPid = 2147483647
  writeFileSync(file, JSON.stringify(journal)); prepareDshProfile(input)
  expect(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8')).toBe('allowBuilds: {}\n')
  expect(JSON.parse(readFileSync(file, 'utf8')).operations.op.result.outcome).toBe('unknown')
})

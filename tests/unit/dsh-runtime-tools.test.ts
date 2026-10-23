import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { packageManagerEnvironment } from '../../dsh/lca-bridge/runtime-tools.js'

const roots: string[] = []
const setup = () => { const root = mkdtempSync(join(tmpdir(), 'lca-node-shim-')); roots.push(root); return root }
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-node-shim-'))) throw new Error('Unsafe cleanup path')
    rmSync(root, { recursive: true, force: true })
  }
})

it.runIf(process.platform === 'win32')('runs node lifecycle commands with only Windows and the owned shim on PATH', () => {
  const root = setup(), windows = process.env.SystemRoot!
  vi.stubEnv('Path', `${windows}\\System32;${windows}`); vi.stubEnv('PATH', `${windows}\\System32;${windows}`)
  const base = { ...process.env }, beforePath = process.env.Path
  const before = spawnSync(join(windows, 'System32/where.exe'), ['node'], { env: base, windowsHide: true })
  expect(before.status).toBe(1)
  const env = packageManagerEnvironment(root)
  const result = spawnSync(join(windows, 'System32/cmd.exe'), ['/d', '/s', '/c', 'node --version'], { env: { ...base, ...env }, windowsHide: true, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe(process.version)
  expect(process.env.Path).toBe(beforePath)
})

it.runIf(process.platform === 'win32')('refuses to replace an unknown node command', () => {
  const root = setup(), bin = join(root, '.lca-runtime-bin'); mkdirSync(bin)
  const file = join(bin, 'node.cmd'); writeFileSync(file, 'user command')
  expect(() => packageManagerEnvironment(root)).toThrow('LCA_RUNTIME_TOOL_CONFLICT')
  expect(readFileSync(file, 'utf8')).toBe('user command')
})

it.runIf(process.platform === 'win32')('refuses a directory junction instead of writing outside the profile', () => {
  const root = setup(), outside = setup()
  symlinkSync(outside, join(root, '.lca-runtime-bin'), 'junction')
  expect(() => packageManagerEnvironment(root)).toThrow('LCA_RUNTIME_TOOL_CONFLICT')
})

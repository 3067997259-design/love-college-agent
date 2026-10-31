// Shared by the packaged main process and isolated command-line probes.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const dshCli = (root) => { const npm = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'); return existsSync(npm) ? npm : join(root, 'apps', 'cli', 'lib', 'bin.js') }
export function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, file) }
  finally { if (existsSync(temp)) unlinkSync(temp) }
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export function prepareDshProfile({ dshRoot, dataDir, bridge }) {
  const home = join(dataDir, 'dsh-home'), profile = join(home, 'profiles', 'lca')
  mkdirSync(profile, { recursive: true })
  const file = join(profile, 'package.json')
  const operationFile = join(profile, 'lca-extension-operations.json')
  if (existsSync(operationFile)) {
    const journal = JSON.parse(readFileSync(operationFile, 'utf8'))
    if (journal.version !== 1 || !journal.operations || Array.isArray(journal.operations)) throw new Error('LCA_EXTENSION_LEDGER_INVALID')
    for (const entry of Object.values(journal.operations)) if (entry.result?.outcome === 'pending' || typeof entry.workspaceBefore === 'string') {
      const alive = (pid) => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
      const runFile = join(profile, '.plugin-manager', 'run.json')
      if (alive(entry.hostPid) || existsSync(runFile) && alive(JSON.parse(readFileSync(runFile, 'utf8')).pid)) throw new Error('LCA_EXTENSION_STILL_RUNNING')
      if (typeof entry.workspaceBefore === 'string') { writeFileSync(join(profile, 'pnpm-workspace.yaml'), entry.workspaceBefore); delete entry.workspaceBefore }
      entry.result.outcome = 'unknown'
    }
    atomicJson(operationFile, journal)
  }
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null
  const manifest = before === null ? { name: 'dsh-profile-lca', private: true } : JSON.parse(before)
  if (!object(manifest) || manifest.dependencies !== undefined && !object(manifest.dependencies)
    || manifest.dsh !== undefined && !object(manifest.dsh) || manifest.dsh?.profile !== undefined && !object(manifest.dsh.profile)
    || manifest.dsh?.profile?.bundles !== undefined && (!Array.isArray(manifest.dsh.profile.bundles) || manifest.dsh.profile.bundles.some((x) => typeof x !== 'string'))) throw new Error('LCA_PROFILE_INVALID')
  manifest.dependencies = { ...manifest.dependencies, '@lca/dsh-bridge': `link:${bridge.replaceAll('\\', '/')}` }
  // The base must precede user layers; the bridge's safety settings win over bundle defaults.
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: ['@deepseek-ai/dsh-base',
    ...new Set((manifest.dsh?.profile?.bundles ?? []).filter((x) => !['@deepseek-ai/dsh-base', '@lca/dsh-bridge'].includes(x))), '@lca/dsh-bridge'] } }
  if (before !== JSON.stringify(manifest, null, 2) + '\n') {
    // Keep an exact migration backup. Invalid inputs are never overwritten.
    if (before !== null) writeFileSync(`${file}.before-${randomUUID()}`, before, { flag: 'wx', mode: 0o600 })
    atomicJson(file, manifest)
  }
  if (!existsSync(join(profile, 'cordis.patch.yml'))) writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  if (!existsSync(join(profile, 'pnpm-workspace.yaml'))) writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n')
  const link = join(profile, 'node_modules', '@lca', 'dsh-bridge')
  let linked = null, present = false
  try { const stat = lstatSync(link); present = true; if (stat.isSymbolicLink()) linked = resolve(dirname(link), readlinkSync(link)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (linked !== resolve(bridge)) {
    if (present) { if (!lstatSync(link).isSymbolicLink()) throw new Error('LCA_BRIDGE_LINK_CONFLICT'); unlinkSync(link) }
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(bridge, link, 'junction')
  }
  return { home, profile, cli: dshCli(dshRoot) }
}

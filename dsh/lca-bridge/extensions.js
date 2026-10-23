// A deliberately small management port. No service name, patch id or arbitrary RPC crosses it.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parse, parseDocument } from 'yaml'
import { atomicJson } from './profile.js'
import { fingerprintDirectory } from './extension-files.js'

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reserved = (name) => name === '@lca/dsh-bridge' || name === '@deepseek-ai/dsh-base' || name.startsWith('@lca/') || name.startsWith('@deepseek-ai/')
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)
const buildName = (value) => typeof value === 'string' ? value.match(/^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@|$)/)?.[1] : undefined
const failure = (operationId, error) => ({ operationId, outcome: 'failed', restartRequired: false, error })

export function createExtensionAdapter(ctx) {
  const manager = ctx.pluginManager, profile = ctx.profileContext
  const file = join(profile.dir, 'lca-extension-operations.json')
  let ledger = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, operations: {} }
  if (ledger.version !== 1 || !ledger.operations || typeof ledger.operations !== 'object' || Array.isArray(ledger.operations)) throw new Error('LCA_EXTENSION_LEDGER_INVALID')
  for (const entry of Object.values(ledger.operations)) {
    if (!entry || typeof entry.signature !== 'string' || !entry.result) throw new Error('LCA_EXTENSION_LEDGER_INVALID')
    if (entry.result.outcome === 'pending') entry.result.outcome = 'unknown'
  }
  atomicJson(file, ledger)
  let active = null
  const started = new Set(profile.startedBundles)
  const pnpm = process.env.LCA_PNPM_CLI
  // The installation carries pnpm; neither a system Node nor a PATH-resolved pnpm is required.
  if (pnpm && existsSync(pnpm)) profile.packageManager = { command: process.execPath, args: [pnpm], env: { ELECTRON_RUN_AS_NODE: '1', npm_config_manage_package_manager_versions: 'false' } }
  const profileStamp = () => digest(['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'].map((name) => {
    const path = join(profile.dir, name); return existsSync(path) ? readFileSync(path, 'utf8') : null
  }))
  const list = async () => {
    const stamp = profileStamp()
    const inventory = await manager.listPlugins()
    return (await manager.listBundles()).map((item) => {
      const rows = item.rows.map((row) => inventory.find((entry) => entry.entryId === row.entryId))
      const applied = item.error || rows.some((row) => row?.fiberPhase === 'failed') ? 'failed' : !started.has(item.name) ? 'disabled'
        : rows.some((row) => !row || row.enabled && row.fiberPhase !== 'active') ? 'unknown' : 'ready'
      return {
      name: item.name, version: item.version ?? null,
      fingerprint: digest([stamp, item.name, item.version, item.source, item.rows, item.overrides]),
      installed: item.installed || item.availability === 'installation', enabled: item.enabled,
      applied,
      protected: reserved(item.name) || item.availability === 'installation' || !!item.readOnlyReason,
      builtin: item.availability === 'installation' || reserved(item.name),
      restartRequired: item.enabled !== started.has(item.name),
    } })
  }
  // Existing core rows cannot be replaced by a managed bundle's declarative patch. Code plugins themselves
  // are trusted host code after approval, not an OS sandbox; this does not claim to sandbox arbitrary JS.
  const inspectLocal = (spec, fingerprint) => {
    const path = spec.startsWith('file:') ? spec.slice(5) : ''
    if (!path || !isAbsolute(path) || fingerprintDirectory(path) !== fingerprint) throw new Error('stale')
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
    if (typeof manifest.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(manifest.name) || reserved(manifest.name)) throw new Error('protected')
    const patches = manifest.dsh?.bundle?.patch
    const paths = typeof patches === 'string' ? [patches] : Array.isArray(patches) ? patches : []
    if (!paths.length) throw new Error('invalid')
    for (const patch of paths) {
      if (typeof patch !== 'string') throw new Error('invalid')
      const target = resolve(path, patch), rel = relative(path, target)
      if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('invalid')
      const rows = parse(readFileSync(target, 'utf8'))
      if (!Array.isArray(rows)) throw new Error('invalid')
      // Management only adds a bundle's own namespaced rows; no core configuration / row edits.
      for (const row of rows) {
        if (!row || Object.keys(row).some((key) => key !== 'insert') || !Array.isArray(row.insert)) throw new Error('protected')
        const check = (entries) => { for (const entry of entries) {
          if (!entry || typeof entry.id !== 'string' || !entry.id.startsWith(`${manifest.name}:`) || typeof entry.name !== 'string' || reserved(entry.name)) throw new Error('protected')
          if (entry.children) check(entry.children)
        } }
        check(row.insert)
      }
    }
    return manifest.name
  }
  const convert = (id, result) => ({ operationId: id,
    outcome: result.application === 'cancelled' ? 'cancelled' : ['failed', 'overridden'].includes(result.application) ? 'failed' : 'succeeded',
    restartRequired: result.application === 'restart-required' || result.error?.code === 'stop-profile',
    ...(result.error ? { error: result.error.code === 'stop-profile' ? 'stop-profile' : result.pendingBuilds?.length ? 'build-blocked' : result.packageResult?.timedOut ? 'timeout' : 'failed' } : {}),
    ...(result.pendingBuilds?.length ? { pendingBuilds: [...new Set(result.pendingBuilds.map(buildName).filter(Boolean))] } : {}),
  })
  return {
    busy: () => active !== null,
    request: async (input) => {
      if (input.action === 'list') return { items: await list() }
      if (!validId(input.operationId)) throw new Error('LCA_EXTENSION_INVALID')
      if (input.action === 'reconcile' || input.action === 'cancel') {
        if (input.action === 'cancel' && active === input.operationId) await manager.cancelInstall(input.operationId)
        // Same-process results are durable before the reply. A lost process cannot prove arbitrary script effects;
        // its unknown receipt remains unknown, with freshly observed declarations, and is never replayed.
        return { items: await list(), operation: ledger.operations[input.operationId]?.result ?? { operationId: input.operationId, outcome: 'unknown', restartRequired: false } }
      }
      const signature = digest(input), previous = ledger.operations[input.operationId]
      if (previous) {
        if (previous.signature !== signature) return { items: await list(), operation: failure(input.operationId, 'stale') }
        return { items: await list(), operation: previous.result }
      }
      if (active) return { items: await list(), operation: failure(input.operationId, 'busy') }
      if (Object.values(ledger.operations).some((entry) => typeof entry.workspaceBefore === 'string')) return { items: await list(), operation: failure(input.operationId, 'unavailable') }
      const entry = { signature, hostPid: process.pid, result: { operationId: input.operationId, outcome: 'pending', restartRequired: false } }
      ledger.operations[input.operationId] = entry
      atomicJson(file, ledger) // Record intent before any side effect.
      active = input.operationId
      try {
        if (!pnpm || !existsSync(pnpm)) throw new Error('unavailable')
        const manifest = JSON.parse(readFileSync(join(profile.dir, 'package.json'), 'utf8'))
        if (input.action === 'install' && Object.keys(manifest.scripts ?? {}).some((name) => /^(preinstall|install|postinstall|prepublish|preprepare|prepare|postprepare)$/.test(name))) throw new Error('protected')
        let result
        if (input.action === 'install') {
          const name = inspectLocal(input.spec, input.fingerprint)
          if ((await list()).some((item) => item.name === name && item.installed)) throw new Error('stale')
          const approved = input.approvedBuilds ?? []
          if (!Array.isArray(approved) || approved.some((name) => typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name))) throw new Error('invalid')
          const blocked = Object.values(ledger.operations).findLast((old) => old.sourceFingerprint === input.fingerprint
            && old.result.outcome === 'failed' && approved.every((name) => old.result.pendingBuilds?.includes(name)))
          if (approved.length && !blocked) throw new Error('stale')
          const keys = approved.flatMap((name) => blocked?.buildKeys?.filter((key) => buildName(key) === name) ?? [])
          if (approved.length && !keys.length) throw new Error('stale')
          entry.sourceFingerprint = input.fingerprint
          const workspace = join(profile.dir, 'pnpm-workspace.yaml'), before = readFileSync(workspace, 'utf8')
          const policy = parseDocument(before)
          if (policy.errors.length) throw new Error('invalid')
          // Per-operation scripts: old profile grants do not carry over, and this decision is not retained.
          for (const key of ['onlyBuiltDependencies', 'neverBuiltDependencies', 'ignoredBuiltDependencies', 'dangerouslyAllowAllBuilds']) policy.delete(key)
          policy.set('allowBuilds', Object.fromEntries(keys.map((key) => [key, true])))
          policy.set('strictDepBuilds', true); policy.set('ignoreScripts', false)
          // Crash recovery restores this exact file before any next operation / startup composition.
          entry.workspaceBefore = before; atomicJson(file, ledger)
          writeFileSync(workspace, String(policy))
          try { result = await manager.installBundle(input.spec, { enabled: false, saveExact: true, requestId: input.operationId }); entry.buildKeys = result.pendingBuilds ?? [] }
          finally { writeFileSync(workspace, before); delete entry.workspaceBefore }
        } else {
          const item = (await list()).find((item) => item.name === input.target)
          if (!item || item.fingerprint !== input.fingerprint) throw new Error('stale')
          if (item.protected) throw new Error('protected')
          if (input.action === 'enable') {
            const bundle = (await manager.listBundles()).find((bundle) => bundle.name === input.target)
            if (!bundle || bundle.overrides.length || bundle.rows.some((row) => !row.rowId.startsWith(`${item.name}:`) || reserved(row.moduleName))) throw new Error('protected')
          }
          if (input.action === 'remove') {
            const before = profile.packageManager
            profile.packageManager = { ...before, args: [...before.args, '--config.ignore-scripts=true'] }
            try { result = await manager.removeBundle(input.target) } finally { profile.packageManager = before }
          }
          else if (input.action === 'enable' || input.action === 'disable') result = await manager.setBundleEnabled(input.target, input.action === 'enable')
          else throw new Error('invalid')
        }
        entry.result = convert(input.operationId, result)
      } catch (error) { entry.result = failure(input.operationId, ['protected', 'stale', 'invalid', 'unavailable'].includes(error.message) ? error.message : 'failed') }
      finally {
        if (typeof entry.workspaceBefore === 'string') entry.result = { operationId: input.operationId, outcome: 'unknown', restartRequired: true, error: 'unavailable' }
        active = null; atomicJson(file, ledger)
      }
      return { items: await list(), operation: entry.result }
    },
  }
}

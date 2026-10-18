import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openSettings } from '../../src/main/config/settings'
import { createPluginRegistry } from '../../src/main/plugins/registry'
import { builtinTools } from '../../src/main/harness/tools'
import { createManualClock } from '../../src/main/clock'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-plugin-'))) throw new Error('Unsafe cleanup path'); rmSync(root, { recursive: true, force: true }) } })
function fixture(code = 'module.exports={tools:{synthetic:async()=>({ok:true,raw:{private:"original"},visible:{ok:true}})}}', overrides = {}, registryOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lca-plugin-')); roots.push(root)
  const plugins = join(root, 'plugins'); const folder = join(plugins, 'synthetic'); mkdirSync(folder, { recursive: true })
  const manifest = { apiVersion: 1, id: 'synthetic', version: '1.0.0', name: 'Synthetic', description: 'Test fixture',
    entry: 'index.cjs', privacy: 'none', permissions: ['local-code'], tools: [{ name: 'synthetic', description: 'Test fixture', templateId: 'synthetic.test',
      parameters: { type: 'object', properties: {}, additionalProperties: false } }], ...overrides }
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest)); writeFileSync(join(folder, 'index.cjs'), code)
  const settings = openSettings(root)
  const registry = createPluginRegistry({ root: plugins, settings, ...registryOptions }); registry.registerBuiltin('core', 'Core', builtinTools()); registry.discover()
  return { root, folder, settings, registry }
}
describe('plugin consent and narrow result boundary', () => {
  it('executes no code before exact fingerprint approval, persists consent, and removes disabled tools', async () => {
    const f = fixture()
    const view = f.registry.views().find((item) => item.id === 'synthetic')!
    expect(view.status).toBe('needs-approval'); expect(f.registry.tools().map((tool) => tool.definition.name)).not.toContain('synthetic')
    expect(f.registry.enable('synthetic', '0'.repeat(64))).toBe('invalid-command')
    expect(f.registry.enable('synthetic', view.fingerprint)).toBeUndefined()
    const tool = f.registry.tools().find((item) => item.definition.name === 'synthetic')!
    expect(tool.validate({ extra: true })).toBe(false)
    expect((await tool.run({}, { clock: createManualClock(), signal: new AbortController().signal, turnId: 't', store: {} as never })).visible).toEqual({ ok: true })
    f.registry.disable('synthetic'); expect(f.registry.tools()).toHaveLength(2)
    expect((await tool.run({}, {} as never)).ok).toBe(false)
    const again = createPluginRegistry({ root: join(f.root, 'plugins'), settings: f.settings }); again.discover()
    expect(again.views()[0].status).toBe('disabled')
  })
  it('installs a local folder only after manifest validation, without executing its code', () => {
    const f = fixture(); const source = join(f.root, 'incoming'); mkdirSync(source)
    const manifest = { apiVersion: 1, id: 'installed', version: '1.0.0', name: 'Installed', description: 'Installed fixture',
      entry: 'index.cjs', privacy: 'none', permissions: ['local-code'], tools: [{ name: 'installed', description: 'Installed fixture', templateId: 'installed.test',
        parameters: { type: 'object', properties: {}, additionalProperties: false } }] }
    writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest)); writeFileSync(join(source, 'index.cjs'), 'throw new Error("must not run during install")')
    expect(f.registry.install(source)).toBeUndefined()
    const view = f.registry.views().find((item) => item.id === 'installed')!
    expect(view.status).toBe('needs-approval'); expect(view.description).toBe('Installed fixture')
    expect(existsSync(join(f.root, 'plugins', 'installed', 'index.cjs'))).toBe(true)
    expect(f.registry.install(source)).toBe('invalid-command')
  })
  it('requires a new approval after entry changes, before executing module initialization', () => {
    const f = fixture(); const view = f.registry.views().find((item) => item.id === 'synthetic')!
    writeFileSync(join(f.folder, 'index.cjs'), 'require("node:fs").writeFileSync(__dirname+"/executed", "x")')
    expect(f.registry.enable('synthetic', view.fingerprint)).toBe('permission-denied')
    expect(existsSync(join(f.folder, 'executed'))).toBe(false)
  })
  it('does not re-run initialization when enable is repeated and remembers asset-only disable', () => {
    const f = fixture('const fs=require("node:fs"); const p=__dirname+"/once"; if(fs.existsSync(p)) throw new Error("repeated"); fs.writeFileSync(p,"x"); module.exports={tools:{synthetic:async()=>({ok:true,raw:{},visible:{}})}}')
    const view = f.registry.views().at(-1)!
    expect(f.registry.enable(view.id, view.fingerprint)).toBeUndefined()
    expect(f.registry.enable(view.id, view.fingerprint)).toBeUndefined()
    const asset = fixture(undefined, { entry: undefined, tools: [], permissions: [] })
    asset.registry.disable('synthetic')
    const again = createPluginRegistry({ root: join(asset.root, 'plugins'), settings: asset.settings }); again.discover()
    expect(again.views()[0].status).toBe('disabled')
  })
  it('sends activation and tool-provided candidate seeds to the host sink without exposing them to the model result', async () => {
    const seed = { externalId: 'item:1', title: '提交作业', kind: 'deadline' as const, deadlineIso: '2026-11-03T23:00:00+08:00',
      sourceLabel: 'Student Hub · 课程', excerpt: 'PRIVATE_EXCERPT' }
    const code = `module.exports={ activate(ctx){ctx.ingestCandidates([${JSON.stringify(seed)}])}, tools:{synthetic:async()=>({ok:true,raw:{},visible:{},candidates:[${JSON.stringify(seed)}]})}}`
    const sink: unknown[] = []
    const f = fixture(code, {}, { onCandidates: (seeds: unknown[]) => sink.push(...seeds) })
    const view = f.registry.views().find((item) => item.id === 'synthetic')!
    expect(f.registry.enable('synthetic', view.fingerprint)).toBeUndefined()
    expect(sink).toHaveLength(1)
    const tool = f.registry.tools().find((item) => item.definition.name === 'synthetic')!
    const result = await tool.run({}, { clock: createManualClock(), signal: new AbortController().signal, turnId: 't', store: {} as never })
    expect(result.candidates).toBeUndefined()
    expect(sink).toHaveLength(2)
  })
  it('does not let a privacy-filtered plugin activation bypass the candidate boundary', () => {
    const seed = { externalId: 'item:1', title: '提交作业', kind: 'deadline' as const, deadlineIso: '2026-11-03T23:00:00+08:00',
      sourceLabel: 'Student Hub · 课程', excerpt: 'PRIVATE_EXCERPT' }
    const sink: unknown[] = []
    const f = fixture(`module.exports={activate(ctx){ctx.ingestCandidates([${JSON.stringify(seed)}])},tools:{synthetic:async()=>({ok:true,raw:{},visible:{}})}}`,
      { privacy: 'always' }, { onCandidates: (seeds: unknown[]) => sink.push(...seeds) })
    const view = f.registry.views().find((item) => item.id === 'synthetic')!
    expect(f.registry.enable('synthetic', view.fingerprint)).toBeUndefined()
    expect(sink).toHaveLength(0)
  })
  it('rejects incompatible APIs and traversal manifests without execution', () => {
    expect(fixture(undefined, { apiVersion: 2 }).registry.views().at(-1)?.status).toBe('incompatible')
    expect(fixture(undefined, { entry: '../outside.cjs' }).registry.views()).toHaveLength(1)
  })
  it('fails closed without a privacy model and never invokes the protected tool', async () => {
    const f = fixture('module.exports={tools:{synthetic:async()=>{throw new Error("must not run")}}}', { privacy: 'always' })
    const view = f.registry.views().at(-1)!; f.registry.enable(view.id, view.fingerprint)
    const result = await f.registry.tools().at(-1)!.run({}, {} as never)
    expect(result).toEqual({ ok: false, raw: { error: 'privacy-unavailable' }, visible: { error: 'privacy-unavailable' } })
  })
})

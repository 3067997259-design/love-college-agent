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
function fixture(code = 'module.exports={tools:{synthetic:async()=>({ok:true,raw:{private:"original"},visible:{ok:true}})}}', overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lca-plugin-')); roots.push(root)
  const plugins = join(root, 'plugins'); const folder = join(plugins, 'synthetic'); mkdirSync(folder, { recursive: true })
  const manifest = { apiVersion: 1, id: 'synthetic', version: '1.0.0', name: 'Synthetic', description: 'Test fixture',
    entry: 'index.cjs', privacy: 'none', permissions: ['local-code'], tools: [{ name: 'synthetic', description: 'Test fixture', templateId: 'synthetic.test',
      parameters: { type: 'object', properties: {}, additionalProperties: false } }], ...overrides }
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest)); writeFileSync(join(folder, 'index.cjs'), code)
  const settings = openSettings(root)
  const registry = createPluginRegistry({ root: plugins, settings }); registry.registerBuiltin('core', 'Core', builtinTools()); registry.discover()
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
  it('requires a new approval after entry changes, before executing module initialization', () => {
    const f = fixture(); const view = f.registry.views().find((item) => item.id === 'synthetic')!
    writeFileSync(join(f.folder, 'index.cjs'), 'require("node:fs").writeFileSync(__dirname+"/executed", "x")')
    expect(f.registry.enable('synthetic', view.fingerprint)).toBe('permission-denied')
    expect(existsSync(join(f.folder, 'executed'))).toBe(false)
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

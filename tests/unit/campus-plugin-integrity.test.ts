import { createRequire } from 'node:module'
import { appendFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const loadPlugin = createRequire(import.meta.url)
const source = resolve(import.meta.dirname, '../../plugin-packages/campus-assistant')

describe('campus assistant pinned helpers', () => {
  it('loads the distributed plugin without activating it or contacting Student Hub', () => {
    const plugin = loadPlugin(join(source, 'index.cjs'))
    expect(plugin.activate).toBeTypeOf('function')
    expect(plugin.tools.campus_assistant).toBeTypeOf('function')
  })

  it.each(['candidates.cjs', 'bridge.py'])('rejects changed %s before activation', (file) => {
    const folder = mkdtempSync(join(tmpdir(), 'lca-campus-integrity-'))
    try {
      for (const name of ['index.cjs', 'candidates.cjs', 'bridge.py']) copyFileSync(join(source, name), join(folder, name))
      appendFileSync(join(folder, file), '\n# changed fixture bytes\n')
      expect(() => loadPlugin(join(folder, 'index.cjs'))).toThrow('CAMPUS_PLUGIN_CHANGED')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

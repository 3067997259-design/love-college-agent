import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM plugin module loaded by the DSH runtime; no type declarations.
import { HANDOFF_FEEDBACK, TRUST_FEEDBACK, createLineage, gatedWhileDegraded, handoffOf, isRisky, parseRoutes, sameModel, sandboxDenied, sourceOf, subjectOf } from '../../dsh/lca-bridge/policy.js'

const agent = (id: string, parentSession?: string) => ({ session: { id, header: parentSession ? { parentSession, origin: 'subagent' } : {} } })

describe('lca-bridge policy', () => {
  it('hands her first hands-on step to the work model: changes are decided again, looking runs', () => {
    for (const name of ['write', 'edit', 'pwsh', 'bash', 'subagent', 'workflow']) expect(handoffOf(name)).toBe('redo')
    for (const name of ['read', 'glob', 'grep']) expect(handoffOf(name)).toBe('switch')
    for (const name of ['lca_get_timer', 'web_search', 'ask_user']) expect(handoffOf(name)).toBeNull()
    expect(HANDOFF_FEEDBACK).toContain('work model takes over')
    expect(sameModel({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' })).toBe(true)
    // One model with a higher level for work is still a switch: the step is decided again at that level.
    expect(sameModel({ provider: 'p', model: 'm', effort: 'low' }, { provider: 'p', model: 'm', effort: 'max' })).toBe(false)
    expect(parseRoutes(JSON.stringify({ providers: {}, chat: { provider: 'google', model: 'g' }, work: { provider: 'deepseek-official', model: 'd', effort: 'max' } })))
      .toEqual({ chat: { provider: 'google', model: 'g' }, work: { provider: 'deepseek-official', model: 'd', effort: 'max' } })
    for (const text of [undefined, '', 'not json', JSON.stringify({ chat: { provider: 'p' } })]) expect(parseRoutes(text)).toBeNull()
  })

  it('places subagents and their children under the root session', () => {
    const lineage = createLineage((id: string) => id === 'root')
    expect(lineage.rootOf(agent('root'))).toBe('root')
    expect(lineage.rootOf(agent('child', 'root'))).toBe('root')
    expect(lineage.rootOf(agent('grandchild', 'child'))).toBe('root')
    expect(lineage.rootOf(agent('stranger', 'elsewhere'))).toBeNull()
    expect(lineage.rootOf(agent('orphan'))).toBeNull()
    expect(lineage.rootOf(undefined)).toBeNull()
  })

  it('names third-party sources and the tools gated while they are in context', () => {
    expect(['web_fetch', 'web_search', 'read_mcp_resource', 'mcp__docs__lookup'].map(sourceOf)).toEqual(['web', 'web', 'mcp', 'mcp'])
    expect(sourceOf('skill')).toBe('plugin')
    expect(['read', 'grep', 'pwsh', 'subagent', 'lca_get_timer'].map(sourceOf)).toEqual([null, null, null, null, null])
    expect(['write', 'edit', 'pwsh', 'web_fetch', 'mcp__docs__lookup'].every(gatedWhileDegraded)).toBe(true)
    expect(['read', 'glob', 'grep', 'todo_write', 'subagent'].some(gatedWhileDegraded)).toBe(false)
    expect(['lca_get_timer', 'plugin_manager'].every(gatedWhileDegraded)).toBe(true)
    expect(isRisky('git push origin main')).toBe(true)
    expect(isRisky('node test.js')).toBe(false)
    expect(subjectOf({ file_path: 'src/a.js', content: 'x' })).toBe('src/a.js')
    expect(subjectOf({ todos: [] })).toBeNull()
  })

  it('recognises the sandbox failing to grant the workspace, and only that', () => {
    const failed = (text: string) => ({ isError: true, error: { code: 'TOOL_FAILED', message: text }, content: [{ type: 'text', text }] })
    expect(sandboxDenied(failed('Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\work\\demo)'))).toBe(true)
    expect(sandboxDenied({ isError: true, error: { message: 'grantWrite(D:\\work\\demo) failed' }, content: [] })).toBe(true)
    expect(sandboxDenied(failed('node: command exited with code 1'))).toBe(false)
    expect(sandboxDenied({ isError: false, content: [{ type: 'text', text: 'grantWrite( printed by a script' }] })).toBe(false)
    expect(Object.keys(TRUST_FEEDBACK).sort()).toEqual(['declined', 'degraded', 'trusted'])
  })
})

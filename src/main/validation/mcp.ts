import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createMcpConnection } from '../mcp/connection'
import { mcpConfigSchema } from '../mcp/config'
import { systemClock } from '../clock'
import type { ToolContext } from '../harness/tools'

/** Launch the referenced project only as an external MCP process against a new synthetic DB. Never read its runtime/config. */
export async function probeStudentHubMcp(root: string) {
  mkdirSync(root, { recursive: true }); const configPath = join(root, 'synthetic-sources.toml')
  writeFileSync(configPath, '[database]\npath="synthetic.sqlite3"\n[privacy]\nfield_encryption_enabled=false\n[actions]\nenabled=false\n', { mode: 0o600 })
  const referenceRoot = resolve(process.env.LCA_STUDENT_HUB_ROOT ?? 'D:\\student-hub')
  const configured = mcpConfigSchema.parse({ mcpServers: { 'student-hub': {
    command: process.env.LCA_STUDENT_HUB_PYTHON ?? 'python', args: ['-B', '-m', 'student_hub.mcp_server', '--config', configPath, '--db', join(root, 'synthetic.sqlite3')],
    cwd: root, env: { PYTHONPATH: join(referenceRoot, 'src'), PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' }, allowTools: ['integrity_check'], privacy: 'none',
  } } }).mcpServers['student-hub']
  const connection = createMcpConnection({ id: 'student-hub', config: configured, source: 'real', clock: systemClock, privacyModel: null, changed: () => {} })
  try {
    await connection.connect(); if (connection.view().status !== 'ready' || connection.tools().length !== 1) throw new Error('MCP_CONNECT_FAILED')
    const result = await connection.tools()[0].run({}, { clock: systemClock, signal: new AbortController().signal, turnId: 'student-hub-probe' } as ToolContext)
    if (!result.ok) throw new Error('MCP_TOOL_FAILED')
    return { ok: true, probe: 'mcp-student-hub', actualStdioHandshake: true, realReferencedServer: true, isolatedSyntheticDatabase: true, integrityToolCalled: true, noSchoolScan: true, noReferenceRuntimeRead: true }
  } catch { return { ok: false, probe: 'mcp-student-hub', error: 'MCP_STUDENT_HUB_PROBE_FAILED' } } finally { await connection.disconnect() }
}

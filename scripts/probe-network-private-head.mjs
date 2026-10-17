import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); let instance
try {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env: { ...runtimeEnv(root), LCA_DATA_DIR: join(root, '.local-data', 'network-head-' + randomUUID()) } })
  const report = await instance.evaluate(async ({ net, session }) => {
    // Read and resolve in main only. No credential headers or response body.
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const input = JSON.parse(readFileSync(process.env.LCA_PROVIDERS_FILE, 'utf8'))
    const target = new URL(input.providers.privacy.base_url).origin
    const proxy = await session.defaultSession.resolveProxy(target)
    const probe = async (send) => {
      try { const response = await send(target, { method: 'HEAD', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000) }); return { reached: true, httpStatus: response.status } }
      catch (error) { const code = error?.cause?.code ?? error?.name; const known = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'TimeoutError', 'AbortError', 'TypeError']); return { reached: false, error: known.has(code) ? code : 'network-failed' } }
    }
    return { probe: 'provider-origin-head', noCredentialsSent: true, noResponseBodyRead: true, modelRequests: 0, systemProxySelected: !proxy.startsWith('DIRECT'), node: await probe(fetch), chromium: await probe(net.fetch) }
  })
  console.log(JSON.stringify(report))
} catch { console.log(JSON.stringify({ ok: false, probe: 'provider-origin-head', error: 'DIAGNOSTIC_FAILED' })); process.exitCode = 1 }
finally { await instance?.close() }

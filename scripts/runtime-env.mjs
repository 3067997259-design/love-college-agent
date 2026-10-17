import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Run the identical native scenario against source Electron or an explicitly supplied build. */
export function electronLaunchTarget(root, fallback) {
  const packaged = process.env.LCA_TEST_EXECUTABLE
  return { executablePath: packaged ?? fallback, args: packaged ? [] : [root] }
}

export function runtimeEnv(root) {
  const cacheRoot = process.platform === 'win32' ? join(root.slice(0, 3), '.lca-cache') : join(root, '.cache')
  for (const part of ['tmp', 'electron', 'electron-builder', 'electron-gyp']) mkdirSync(join(cacheRoot, part), { recursive: true })
  const env = { ...process.env, TEMP: join(cacheRoot, 'tmp'), TMP: join(cacheRoot, 'tmp'),
    ELECTRON_CACHE: join(cacheRoot, 'electron'), ELECTRON_BUILDER_CACHE: join(cacheRoot, 'electron-builder'),
    npm_config_devdir: join(cacheRoot, 'electron-gyp'), LCA_DATA_DIR: process.env.LCA_DATA_DIR ?? join(root, '.local-data'),
    LCA_RENDERER_PORT: process.env.LCA_RENDERER_PORT ?? (basename(root).includes('gpt') ? '5273' : '5173') }
  env.LCA_MCP_PORT = process.env.LCA_MCP_PORT ?? (basename(root).includes('gpt') ? '5275' : '5175')
  env.LCA_CDP_PORT = process.env.LCA_CDP_PORT ?? (basename(root).includes('gpt') ? '9527' : '9427')
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** Existing book-focused scenarios explicitly finish initialization as a real fixture precondition.
 * The onboarding scenario never calls this helper, so it still tests a genuinely fresh profile. */
export async function initializeTestBook(page) {
  await page.waitForFunction(() => !!window.lca)
  const ok = await page.evaluate(async () => {
    const snapshot = await window.lca.getSnapshot()
    if (snapshot.onboarding?.status !== 'needed') return true
    const ack = await window.lca.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'onboarding.complete' })
    return ack.status === 'accepted'
  })
  if (!ok) throw new Error('BOOK_FIXTURE_INITIALIZATION_FAILED')
  await page.getByRole('region', { name: '新手流程', exact: true }).waitFor({ state: 'hidden' })
}

/** Navigate the grouped user settings; the developer panel keeps its direct controls. */
export async function openSettingsGroup(page, name) {
  const summary = page.locator('[data-settings="user"] .settings-group > summary').filter({ hasText: name })
  if (!await summary.count()) return
  const details = summary.locator('..')
  if (!await details.evaluate((element) => element.open)) await summary.click()
}

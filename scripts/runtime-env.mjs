import { mkdirSync } from 'node:fs'
import { basename, join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Run the identical native scenario against source Electron or an explicitly supplied build. */
export function electronLaunchTarget(root, fallback) {
  const packaged = process.env.LCA_TEST_EXECUTABLE
  return { executablePath: packaged ?? fallback, args: packaged ? [] : [root] }
}

/** Windows keeps test caches at the drive root, away from the checkout's path length. */
const testCacheRoot = (root) => process.env.LCA_TEST_CACHE_ROOT ?? (process.platform === 'win32' ? join(root.slice(0, 3), '.lca-cache') : join(root, '.cache'))

/**
 * Synthetic profiles may live on a separate volume; every caller still allocates a fresh ID.
 * On Windows they default to the short cache root too: a deep worktree plus a developer scene's
 * nesting pushes a private-save export's SQLite staging copy past 260 characters, and the export
 * then fails as `internal` (seen 2026-11-05 in test:room, test:sleep, test:life-work, test:history).
 */
export const testDataRoot = (root) => resolve(process.env.LCA_TEST_DATA_ROOT ?? (process.platform === 'win32' ? join(testCacheRoot(root), 'data') : join(root, '.local-data')))

export function runtimeEnv(root) {
  const cacheRoot = testCacheRoot(root)
  for (const part of ['tmp', 'electron', 'electron-builder', 'electron-gyp']) mkdirSync(join(cacheRoot, part), { recursive: true })
  const env = { ...process.env, TEMP: join(cacheRoot, 'tmp'), TMP: join(cacheRoot, 'tmp'),
    ELECTRON_CACHE: join(cacheRoot, 'electron'), ELECTRON_BUILDER_CACHE: join(cacheRoot, 'electron-builder'),
    npm_config_devdir: join(cacheRoot, 'electron-gyp'), LCA_DATA_DIR: process.env.LCA_DATA_DIR ?? join(root, '.local-data'),
    LCA_TEST_SILENT: process.env.LCA_TEST_SILENT ?? '1',
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
  if (process.env.LCA_TEST_EXECUTABLE) {
    const expected = resolve(dirname(process.env.LCA_TEST_EXECUTABLE), 'resources/app.asar/out/renderer/index.html')
    const actual = resolve(fileURLToPath(page.url()))
    const canonical = (path) => process.platform === 'win32' ? path.toLowerCase() : path
    if (canonical(actual) !== canonical(expected)) throw new Error('PACKAGED_TEST_TARGET_MISMATCH')
  }
  const ok = await page.evaluate(async () => {
    const snapshot = await window.lca.getSnapshot()
    if (snapshot.onboarding?.status !== 'needed') return true
    const ack = await window.lca.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'onboarding.complete' })
    return ack.status === 'accepted'
  })
  if (!ok) throw new Error('BOOK_FIXTURE_INITIALIZATION_FAILED')
  await page.getByRole('region', { name: '新手流程', exact: true }).waitFor({ state: 'hidden' })
}

/**
 * Maintenance folds (details.settings-advanced) start closed for people. Scripts reach into them
 * directly, so opening settings, or one of its groups, also opens every such fold.
 */
async function openFolds(page) {
  await page.evaluate(() => { for (const fold of document.querySelectorAll('details.settings-advanced')) fold.open = true })
}

/** Open settings: the book's 设置 bookmark turns to the settings page; developer mode keeps its floating tools panel. */
export async function openSettings(page) {
  const mode = await page.evaluate(async () => (await window.lca.getSnapshot()).runtime?.developer.mode)
  if (mode === 'developer') await page.getByRole('button', { name: '工具与设置', exact: true }).click()
  else await page.locator('nav.bookmarks').getByRole('button', { name: '设置', exact: true }).click()
  await openFolds(page)
}

/** Leave settings: the settings page turns back to the conversation; developer mode closes its floating panel. */
export async function closeSettings(page) {
  const mode = await page.evaluate(async () => (await window.lca.getSnapshot()).runtime?.developer.mode)
  if (mode === 'developer') { await page.getByRole('button', { name: '关闭', exact: true }).click(); return }
  await page.locator('nav.bookmarks').getByRole('button', { name: /^对话/ }).click()
  await page.locator('[data-settings="user"]').waitFor({ state: 'hidden' })
}

/** Navigate the grouped user settings; the developer panel keeps its direct controls. */
export async function openSettingsGroup(page, name) {
  const summary = page.locator('[data-settings="user"] .settings-group > summary').filter({ hasText: name })
  if (!await summary.count()) return
  const details = summary.locator('..')
  if (!await details.evaluate((element) => element.open)) await summary.click()
  await openFolds(page)
}

/**
 * Her turns run on DSH, a moment longer than the legacy loop's scripted turns took: a command the book refuses while
 * she is still speaking (a private save, say) is sent again until it is accepted, for up to 15 seconds.
 */
export async function whenIdle(send, body) {
  for (let i = 0; i < 150; i++) {
    const ack = await send(body)
    if (ack.status !== 'rejected' || ack.error?.code !== 'unavailable') return ack
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('BUSY_TOO_LONG:' + body.type)
}

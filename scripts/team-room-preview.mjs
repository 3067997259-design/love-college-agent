// Fake-data visual acceptance; local Chrome only, no downloaded browser or real provider.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..'), output = join(root, 'test-results/team-v2-preview')
mkdirSync(output, { recursive: true })
const server = await createServer({ root: join(root, 'src/renderer'), configFile: false, logLevel: 'error', plugins: [react()],
  resolve: { alias: { '@renderer': join(root, 'src/renderer/src'), 'three/examples/jsm/libs/meshopt_decoder.module.js': join(root, 'src/renderer/src/tools/meshopt-disabled.ts') } },
  server: { host: '127.0.0.1', port: Number(process.env.LCA_SHOT_PORT ?? 5187), strictPort: true } })
await server.listen()
if (process.argv.includes('--serve')) {
  console.log(`TEAM_PREVIEW_URL http://127.0.0.1:${server.config.server.port}/?scenario=team-working`)
  await new Promise(() => {})
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors = [], checks = []
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) errors.push(`${response.status()} ${response.url()}`) })
  await page.goto(`http://127.0.0.1:${server.config.server.port}/?scenario=team-working`)
  await page.locator('.team-mini[data-station="table"]').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1400)
  // Three tea-table seats, each with its laptop; the helper at the left end is redrawn above the table from her hands up.
  assert.equal(await page.locator('.team-mini[data-station="table"]').count(), 3)
  assert.equal(await page.locator('.team-laptop').count(), 3)
  assert.equal(await page.locator('.team-over').count(), 1)
  assert.equal(await page.locator('.team-mini[data-station="bookshelf"]').count(), 1)
  assert.equal(await page.locator('.team-mini[data-station="desk"]').count(), 1)
  assert.equal(await page.locator('.team-occluder').count(), 3)
  await page.locator('.page-left').screenshot({ path: join(output, 'day.png') })
  await page.locator('.team-room').screenshot({ path: join(output, 'room.png') })
  checks.push('station-counts-laptops-and-three-occlusion-layers')
  await page.getByRole('button', { name: /^首页：/ }).locator('.team-mini-hit').click()
  const card = page.getByRole('dialog', { name: '首页', exact: true })
  await card.getByText('src/pages/index.html', { exact: true }).first().waitFor()
  assert.ok((await card.textContent()).includes('改文件'))
  await page.locator('.page-left').screenshot({ path: join(output, 'card.png') })
  await card.getByRole('button', { name: '收起', exact: true }).click()
  await page.getByRole('button', { name: /^检查：/ }).locator('.team-mini-hit').click()
  const restricted = page.getByRole('dialog', { name: '检查', exact: true })
  await restricted.locator('.team-card-history li').first().waitFor()
  assert.ok(!(await restricted.textContent()).includes('src/pages'))
  assert.ok((await restricted.textContent()).includes('只显示步骤种类'))
  await restricted.getByRole('button', { name: '收起', exact: true }).click()
  checks.push('on-demand-chinese-history-and-source-withholding')
  for (const mini of await page.locator('.team-mini').all()) {
    await mini.locator('.team-mini-hit').click()
    await page.getByRole('dialog').getByRole('button', { name: '收起', exact: true }).click()
  }
  checks.push('every-visible-helper-clickable')
  // The development-only scenario toolbar overlaps the book footer; move it for the shot-toggle check.
  await page.locator('.dev-switcher').evaluate((node) => { node.style.top = '0'; node.style.bottom = 'auto' })
  await page.getByRole('button', { name: '回到桌前', exact: true }).click()
  assert.ok(await page.locator('.team-mini-hit').evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).pointerEvents === 'none')))
  await page.getByRole('button', { name: '看看房间', exact: true }).click()
  await page.getByRole('button', { name: '换时段', exact: true }).click()
  await page.getByRole('button', { name: '换时段', exact: true }).click()
  await page.waitForTimeout(1400)
  await page.locator('.page-left').screenshot({ path: join(output, 'night.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.ok(await page.locator('.team-mini').evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).transitionDuration.split(',').every((part) => parseFloat(part) === 0))))
  assert.ok(await page.locator('.team-mini img').evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).animationName === 'none')))
  await page.locator('.page-left').screenshot({ path: join(output, 'reduced-motion.png') })
  checks.push('day-night-and-reduced-motion')
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.getByRole('button', { name: /^首页：/ }).locator('.team-mini-hit').click()
  const narrow = page.getByRole('dialog', { name: '首页', exact: true })
  await narrow.locator('.team-card-history li').first().waitFor()
  assert.ok(await narrow.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
  const bounds = await narrow.boundingBox(), room = await page.locator('.team-room').boundingBox()
  assert.ok(bounds.x >= room.x - 1 && bounds.x + bounds.width <= room.x + room.width + 1)
  await page.screenshot({ path: join(output, 'narrow.png') })
  checks.push('narrow-card-bounds')
  await page.setViewportSize({ width: 1600, height: 1000 })
  for (const scene of ['team-workstations', 'team-statuses', 'team-blocked']) {
    await page.goto(`http://127.0.0.1:${server.config.server.port}/?scenario=${scene}`)
    await page.locator('.team-mini').first().waitFor()
    await page.waitForTimeout(1400)
    const expected = scene === 'team-workstations' ? 9 : 6
    assert.equal(await page.locator('.team-mini').count(), expected)
    assert.ok(await page.locator('.team-mini img, .team-laptop').evaluateAll((images) => images.every((img) => img.complete && img.naturalWidth > 0)))
    assert.equal(await page.locator('.team-laptop').count(), await page.locator('.team-mini[data-station="table"]').count())
    await page.locator('.page-left').screenshot({ path: join(output, `${scene}.png`) })
    for (const mini of await page.locator('.team-mini').all()) {
      await mini.locator('.team-mini-hit').click()
      const name = (await mini.getAttribute('aria-label')).split('：')[0]
      assert.equal(await page.getByRole('dialog').getAttribute('aria-label'), name)
      await page.keyboard.press('Escape')
      assert.ok(await mini.evaluate((node) => node === document.activeElement))
      await page.keyboard.press('Enter')
      await page.getByRole('dialog').getByRole('button', { name: '收起', exact: true }).click()
    }
    checks.push(`${scene}-assets-pointer-keyboard-and-focus`)
  }
  assert.deepEqual(errors, [])
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, errors, syntheticOnly: true }, null, 2))
  console.log('TEAM_PREVIEW_PASS', checks, output)
} finally { await browser.close(); await server.close() }

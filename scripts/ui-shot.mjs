// 书本界面的截图预览：只起渲染层的 Vite（假数据场景），用本机已装的 Chrome 无头截图。
// 用法：node scripts/ui-shot.mjs [输出目录] [场景...]
// 不下载浏览器（channel: 'chrome' 用系统 Chrome，临时配置），不碰用户的浏览器配置。
import { mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(process.argv[2] ?? join(root, '.local-data', 'ui-shots'))
const only = process.argv.slice(3)
const scenarios = only.length ? only : ['morning-idle', 'plan-proposed', 'focus-working', 'break-delivery', 'streaming', 'night-lamp', 'lights-out', 'out-shore', 'asleep', 'mail-failed', 'evening-home']
const sizes = [{ name: '', width: 1600, height: 1000 }]
if (process.env.LCA_SHOT_SMALL) sizes.push({ name: '-small', width: 1280, height: 720 })

mkdirSync(outDir, { recursive: true })
const server = await createServer({
  root: join(root, 'src/renderer'),
  configFile: false,
  logLevel: 'error',
  plugins: [react()],
  // 和 electron.vite.config.ts 一样换掉 meshopt 解码器：它会在 script-src 'self' 下编译 WASM，触发 CSP 报错
  resolve: { alias: { '@renderer': join(root, 'src/renderer/src'), 'three/examples/jsm/libs/meshopt_decoder.module.js': join(root, 'src/renderer/src/tools/meshopt-disabled.ts') } },
  server: { host: '127.0.0.1', port: Number(process.env.LCA_SHOT_PORT ?? 5175), strictPort: true },
})
await server.listen()
const base = `http://127.0.0.1:${server.config.server.port}/`
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`) })
    for (const id of scenarios) {
      await page.goto(`${base}?scenario=${id}`)
      await page.locator('.stage').waitFor()
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(Number(process.env.LCA_SHOT_WAIT ?? 900)) // 等入场和时段过渡
      const file = join(outDir, `${id}${size.name}.png`)
      await page.screenshot({ path: file })
      console.log(file)
    }
    if (errors.length) console.log('页面报错：\n' + errors.join('\n'))
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}

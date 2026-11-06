// Diagnosis only: determine whether installed Chromium starts outside Agent Browser's launcher.
import { chromium } from 'playwright'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const directory = resolve('test-results', 'browser-launch-control-' + randomUUID())
mkdirSync(directory, { recursive: true })
const results = []
const variant = process.env.LCA_PROBE_CONTROL || 'system'
for (const executablePath of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
  let browser
  try {
    const home = join(directory, 'home'); mkdirSync(join(home, 'tmp'), { recursive: true })
    browser = await chromium.launchPersistentContext(join(home, executablePath.includes('Edge') ? 'edge-profile' : 'chrome-profile'), { executablePath: variant === 'extended-path' ? '\\\\?\\' + executablePath.replaceAll('/', '\\') : executablePath, chromiumSandbox: true, headless: true, timeout: 10000 })
    const page = await browser.newPage(); await page.setContent('<title>isolated launch control</title>')
    results.push({ executablePath, ok: (await page.title()) === 'isolated launch control' })
  } catch (error) { results.push({ executablePath, ok: false, error: String(error).slice(0, 4000) }) }
  finally { await browser?.close() }
}
writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ variant, results }, null, 2))
console.log(JSON.stringify({ variant, results, directory }))
if (results.some((result) => !result.ok)) process.exitCode = 1

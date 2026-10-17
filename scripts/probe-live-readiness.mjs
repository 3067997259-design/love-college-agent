import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'live-readiness-' + randomUUID())
// Only the application's main process reads this optional file; never inspect it in this script.
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data }; delete env.LCA_BOOTH
let instance
try {
  await mkdir(data, { recursive: true }); instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); const page = await instance.firstWindow()
  await page.waitForFunction(() => !!window.lca)
  const snapshot = await page.evaluate(() => window.lca.getSnapshot()); assert.equal(snapshot.runtime.developer.mode, 'normal'); assert.equal(snapshot.onboarding.status, 'needed')
  const slots = new Set(snapshot.modelSettings?.configuredSlots ?? [])
  const availability = { chat: slots.has('chat'), background: slots.has('background'), privacy: slots.has('privacy'), speech: snapshot.voice?.available ?? false, gifts: snapshot.gifts?.configured ?? false }
  await instance.close(); instance = undefined
  let requests = 0
  for (const owner of await readdir(join(data, 'journals'))) for (const file of await readdir(join(data, 'journals', owner))) if (file.endsWith('.jsonl')) for (const line of (await readFile(join(data, 'journals', owner, file), 'utf8')).trim().split('\n')) {
    const row = JSON.parse(line); if (row.type === 'model/attempt' && row.status === 'started' || row.type === 'voice/attempt' || row.type === 'gift/state' && row.gift.status === 'making') requests++
  }
  assert.equal(requests, 0, 'READINESS_MUST_NOT_REQUEST_MODELS')
  console.log(JSON.stringify({ ok: true, probe: 'live-readiness', mainProcessReadOnly: true, configuredCapabilities: availability, noModelRequests: true, isolatedNewProfile: true, connectionOrQualityAccepted: false }))
} finally { await instance?.close() }

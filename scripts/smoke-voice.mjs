import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runtimeEnv, initializeTestBook } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'voice-smoke-' + randomUUID()); const sceneId = randomUUID(); const profile = join(data, 'developer', sceneId)
const env = { ...runtimeEnv(root), LCA_DATA_DIR: data, LCA_PROVIDERS_FILE: join(data, 'absent.json'), LCA_CDP_PORT: '19549', LCA_MCP_PORT: '0' }
let instance; let page; let client
const snapshot = () => page.evaluate(() => window.lca.getSnapshot())
const send = (body) => page.evaluate(async (body) => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), ...body }) }, body)
async function waitFor(test, message) { for (let i = 0; i < 100; i++) { if (test(await snapshot())) return; await new Promise((done) => setTimeout(done, 100)) }; throw new Error(message) }
const debug = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError); return JSON.parse(result.content[0].text) }
async function launch() {
  instance = await _electron.launch({ executablePath: electronPath, args: [root], env }); page = await instance.firstWindow(); await initializeTestBook(page)
  // Exercise the real AudioContext scheduler without making sound on the user's computer.
  await instance.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.setAudioMuted(true) })
  const config = JSON.parse(await readFile(join(profile, 'debug-connection.json'), 'utf8')); client = new Client({ name: 'voice-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } }))
  await debug('set_clock', { frozen: true })
}
async function close() { await client?.close(); client = undefined; await instance?.close(); instance = undefined }
async function chat() { await debug('set_fake_model', { script: [{ text: 'PUBLIC_SYNTHETIC_VOICE_REPLY', toolCalls: [], delayMs: 0 }] }); assert.equal((await send({ type: 'message.send', text: '合成语音流程。' })).status, 'accepted'); await waitFor((s) => s.task?.status === 'completed', 'CHAT_NOT_DONE') }
async function advance() { await debug('set_clock', { nowMs: (await snapshot()).clock.nowMs + 100, frozen: true }) }
try {
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, developer: true, booth: false, plugins: {}, sceneId }))
  await launch(); assert.deepEqual((await snapshot()).voice, { enabled: false, available: true, source: 'fake' }); await chat(); assert.equal((await snapshot()).voice.utterance, undefined)
  await page.getByRole('button', { name: '工具与设置', exact: true }).click(); await page.getByRole('button', { name: '开启语音', exact: true }).click(); await chat()
  await waitFor((s) => s.voice.utterance?.chunkCount === 1, 'FIRST_CHUNK_MISSING'); const id = (await snapshot()).voice.utterance.id
  let audio = await page.evaluate((id) => window.lca.readVoice({ utteranceId: id, afterChunk: -1 }), id); assert.equal(audio.done, false); assert.equal(audio.chunks.length, 1); assert.equal(Buffer.from(audio.chunks[0].pcmBase64, 'base64').length, 4800)
  await advance(); await advance(); await advance(); await waitFor((s) => s.voice.utterance.status === 'ready' && s.voice.utterance.playback === 'ended', 'NATIVE_AUDIO_NOT_ENDED')
  audio = await page.evaluate((id) => window.lca.readVoice({ utteranceId: id, afterChunk: 0 }), id); assert.equal(audio.done, true); assert.equal(audio.chunks.length, 2)
  assert.ok(!JSON.stringify((await snapshot()).voice).includes('PUBLIC_SYNTHETIC_VOICE_REPLY'))
  await chat(); await waitFor((s) => s.voice.utterance?.id !== id && s.voice.utterance?.status === 'synthesizing', 'NEW_AUDIO_MISSING')
  const cancelled = (await snapshot()).voice.utterance.id; await send({ type: 'mode.set', mode: 'quiet' }); await waitFor((s) => s.voice.utterance.status === 'cancelled', 'QUIET_DID_NOT_CANCEL')
  assert.equal(await page.evaluate(async (id) => { try { await window.lca.readVoice({ utteranceId: id, afterChunk: -1 }); return false } catch { return true } }, cancelled), true)
  await advance(); await advance(); assert.equal((await snapshot()).voice.utterance.status, 'cancelled'); await chat(); assert.equal((await snapshot()).voice.utterance.id, cancelled)
  const miniCreated = instance.waitForEvent('window'); await send({ type: 'window.mini' }); const mini = await miniCreated; await mini.waitForFunction(() => !!window.lca)
  assert.equal(await mini.evaluate(async (id) => { try { await window.lca.readVoice({ utteranceId: id, afterChunk: -1 }); return false } catch { return true } }, cancelled), true)
  assert.equal((await mini.evaluate(async () => { const s = await window.lca.getSnapshot(); return window.lca.dispatch({ protocolVersion: 1, epoch: s.epoch, requestId: crypto.randomUUID(), type: 'voice.set', enabled: false }) })).error.code, 'permission-denied')
  await send({ type: 'window.expand' }); await close(); await launch(); assert.equal((await snapshot()).voice.enabled, true); assert.equal((await snapshot()).voice.utterance, undefined)
  await send({ type: 'voice.set', enabled: false }); await close(); await launch(); assert.equal((await snapshot()).voice.enabled, false); assert.equal((await snapshot()).voice.utterance, undefined)
  console.log('Voice Electron: explicit enable/default silence, real PCM chunks + AudioContext schedule/end (native output muted), quiet cancellation/no late audio, book-only read/commands, persisted preference and no restart replay; synthetic tone/model only, no real TTS request.')
} finally { await close() }

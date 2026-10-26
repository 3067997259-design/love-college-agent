// Single human-requested NovelAI draft; adapted from frozen film/nai.mjs
// (31b825a458fc915a1e98da808e6d41070dd75962) and D:/lca-workspace/lca-art/tools/nai_gen.py.
// No batches, automatic retries, credential output, or runtime asset replacement.
// Usage: node art/tools/novelai-single.mjs <spec.json> [--dry-run]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const specPath = process.argv[2] && resolve(process.argv[2])
if (!specPath) throw new Error('A spec.json path is required')
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
if (!/^[a-z0-9_-]+$/.test(spec.name) || typeof spec.prompt !== 'string') throw new Error('Invalid name or prompt')
for (const key of ['width', 'height', 'seed']) if (!Number.isSafeInteger(spec[key])) throw new Error(`Invalid ${key}`)
if (spec.width % 64 || spec.height % 64 || spec.width <= 0 || spec.height <= 0 || spec.width * spec.height > 1048576) throw new Error('Use a positive, 64-aligned canvas of at most 1 megapixel')
const params = {
  params_version: 3, width: spec.width, height: spec.height,
  scale: spec.scale ?? 5, sampler: 'k_euler_ancestral', steps: spec.steps ?? 23,
  n_samples: 1, seed: spec.seed, ucPreset: 0, qualityToggle: false,
  noise_schedule: 'karras', cfg_rescale: 0, sm: false, sm_dyn: false,
  dynamic_thresholding: false, legacy: false, legacy_v3_extend: false,
  add_original_image: true, use_coords: false, characterPrompts: [],
  v4_prompt: { caption: { base_caption: spec.prompt, char_captions: [] }, use_coords: false, use_order: true },
  v4_negative_prompt: { caption: { base_caption: spec.negative ?? '', char_captions: [] }, legacy_uc: false },
  negative_prompt: spec.negative ?? '', deliberate_euler_ancestral_bug: false, prefer_brownian: true,
}
const payload = { input: spec.prompt, model: spec.model, action: 'generate', parameters: params }
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ valid: true, model: payload.model, width: params.width, height: params.height, seed: params.seed, steps: params.steps, samples: 1, credentialRead: false, networkRequests: 0 }))
} else {
  const out = dirname(specPath)
  const recordPath = join(out, `${spec.name}-nai-record.json`)
  const pngPath = join(out, `${spec.name}-nai.png`)
  const zipPath = join(out, `${spec.name}-nai-response.zip`)
  if ([recordPath, pngPath, zipPath].some(existsSync)) throw new Error('This attempt already exists; inspect its receipt instead of replaying it')
  // User explicitly requested the historical script route on 2026-10-26.
  // Only this local runner reads the credential file, never the conversation.
  let cfg, endpoint
  try {
    cfg = JSON.parse(readFileSync(join(root, 'secrets/novelai.json'), 'utf8'))
    endpoint = new URL((cfg.api_base ?? 'https://image.novelai.net').replace(/\/$/, '') + '/ai/generate-image')
  } catch {
    throw new Error('Cannot read or parse the local NovelAI configuration; contents withheld')
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid generation endpoint')
  if (typeof cfg.api_token !== 'string' || !cfg.api_token.trim()) throw new Error('Missing API credential')
  payload.model ||= cfg.model
  if (typeof payload.model !== 'string' || !payload.model) throw new Error('Missing model')
  mkdirSync(out, { recursive: true })
  const record = { time: new Date().toISOString(), tool: 'NovelAI API text-to-image', endpoint: endpoint.href, modelRequested: payload.model, modelReported: null, spec: specPath, prompt: spec.prompt, negative: spec.negative, parameters: params, attempt: 1, status: 'request-started', adopted: false }
  const save = () => writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
  save()
  const start = performance.now()
  let phase = 'request'
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { Authorization: 'Bearer ' + cfg.api_token, 'Content-Type': 'application/json', Accept: 'application/zip', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', Origin: 'https://novelai.net', Referer: 'https://novelai.net/' },
      body: JSON.stringify(payload),
    })
    record.httpStatus = response.status
    if (!response.ok) {
      record.status = 'http-error'
      await response.body?.cancel()
      throw new Error('HTTP error')
    }
    const raw = Buffer.from(await response.arrayBuffer())
    writeFileSync(zipPath, raw, { flag: 'wx' })
    phase = 'response-saved'
    const zip = await JSZip.loadAsync(raw)
    const files = Object.values(zip.files).filter(file => !file.dir && file.name.toLowerCase().endsWith('.png'))
    if (files.length !== 1) throw new Error('Expected one PNG')
    const png = await files[0].async('nodebuffer')
    if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG')
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    if (width !== params.width || height !== params.height) throw new Error('Unexpected output dimensions')
    writeFileSync(pngPath, png, { flag: 'wx' })
    Object.assign(record, { status: 'candidate-awaiting-review', file: pngPath, width, height, sha256: createHash('sha256').update(png).digest('hex') })
  } catch {
    if (record.status === 'request-started') record.status = phase === 'response-saved' ? 'response-saved-decode-failed' : 'outcome-unknown'
    process.exitCode = 1
  } finally {
    record.seconds = Math.round((performance.now() - start) / 100) / 10
    save()
    console.log(JSON.stringify({ status: record.status, httpStatus: record.httpStatus, file: record.file, record: recordPath, seconds: record.seconds }))
  }
}

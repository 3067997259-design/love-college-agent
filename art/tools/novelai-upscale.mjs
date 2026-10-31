// Enlarge one image 2x with NovelAI's upscaler, for a maintainer-requested art step.
// As of 2026-10-28 the NovelAI web app sends { image, model: 'nai-diffusion-5-curated', declared_blur_sigma: 0 } to
// image.novelai.net/ai/upscale and reads back a ZIP. That is a diffusion pass conditioned on the image, not a plain
// resampler, so faces must be compared with the source before a result is used.
// Same rules as novelai-single.mjs: one request, no automatic retries, no overwriting, the token never printed.
// Usage: node art/tools/novelai-upscale.mjs <input.png> <output-dir> [--sigma 0] [--host image|api] [--dry-run]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const positional = args.filter((arg, i) => !arg.startsWith('--') && !['--sigma', '--host'].includes(args[i - 1]))
const [inputArg, outArg] = positional
if (!inputArg || !outArg) throw new Error('Usage: novelai-upscale.mjs <input.png> <output-dir> [--sigma 0] [--host image|api] [--dry-run]')
// The web app's constants UPSCALE_MODEL, UPSCALE_FACTOR and UPSCALE_BLUR_SIGMA. The server accepts only these declared blur
// values; 0.5 sharpened a soft 1024 face study without changing the face (art/retouch/2026-10-28-nai-upscale).
const MODEL = 'nai-diffusion-5-curated', scale = 2, SIGMAS = [0, 0.3, 0.35, 0.4, 0.45, 0.5]
const sigma = Number(flag('--sigma', '0'))
if (!SIGMAS.includes(sigma)) throw new Error(`Sigma must be one of ${SIGMAS.join(', ')}`)
// Only NovelAI's own hosts: the token is never sent anywhere else.
const HOSTS = { api: 'https://api.novelai.net', image: 'https://image.novelai.net' }
const host = flag('--host', 'image')
if (!Object.hasOwn(HOSTS, host)) throw new Error('Host must be image or api')
const input = resolve(inputArg), outDir = resolve(outArg)
const png = readFileSync(input)
const isPng = (buffer) => buffer.length > 24 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
if (!isPng(png)) throw new Error('Input must be a PNG file')
const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
// NovelAI resizes other sizes to a multiple of 64 (1024x572 came back as 2048x1120, squashed about 2%). Pad first, crop after.
if ((width % 64 || height % 64) && !args.includes('--allow-resize')) throw new Error(`Pad the input to multiples of 64 first (got ${width}x${height}); --allow-resize accepts NovelAI's resizing`)
const name = `${basename(input).replace(/\.png$/i, '')}-nai-upscale-${host}-x${scale}-s${sigma}`
const outPng = join(outDir, `${name}.png`), recordPath = join(outDir, `${name}-record.json`), rawPath = join(outDir, `${name}-response.bin`)
const endpoint = new URL(`${HOSTS[host]}/ai/upscale`)
if (args.includes('--dry-run')) {
  console.log(JSON.stringify({ valid: true, endpoint: endpoint.href, model: MODEL, sigma, width, height, scale, credentialRead: false, networkRequests: 0 }))
} else {
  if ([outPng, recordPath, rawPath].some(existsSync)) throw new Error('This upscale already exists; inspect its record instead of repeating it')
  let token
  try { token = JSON.parse(readFileSync(join(root, 'secrets/novelai.json'), 'utf8')).api_token } catch { throw new Error('Cannot read the local NovelAI configuration; contents withheld') }
  if (typeof token !== 'string' || !token.trim()) throw new Error('Missing API credential')
  const scrub = (text) => String(text).split(token).join('[token]')
  mkdirSync(outDir, { recursive: true })
  const record = { time: new Date().toISOString(), tool: 'NovelAI upscale', endpoint: endpoint.href, input, inputSha256: createHash('sha256').update(png).digest('hex'), width, height, model: MODEL, declaredBlurSigma: sigma, scale, attempt: 1, status: 'request-started', adopted: false }
  const save = () => writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
  save()
  const started = performance.now()
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/zip, image/png, */*', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', Origin: 'https://novelai.net', Referer: 'https://novelai.net/' },
      body: JSON.stringify({ image: png.toString('base64'), model: MODEL, declared_blur_sigma: sigma }),
    })
    record.httpStatus = response.status
    record.contentType = response.headers.get('content-type')
    if (!response.ok) {
      // NovelAI's own error text (for example a size limit) is worth keeping; it never contains the token.
      record.status = 'http-error'
      record.errorBody = scrub((await response.text()).slice(0, 2000))
      throw new Error('HTTP error')
    }
    const raw = Buffer.from(await response.arrayBuffer())
    writeFileSync(rawPath, raw, { flag: 'wx' })
    let image = raw
    if (raw.subarray(0, 2).toString('latin1') === 'PK') {
      const zip = await JSZip.loadAsync(raw)
      const files = Object.values(zip.files).filter((file) => !file.dir && file.name.toLowerCase().endsWith('.png'))
      if (files.length !== 1) throw new Error('Expected one PNG in the archive')
      image = await files[0].async('nodebuffer')
    }
    if (!isPng(image)) throw new Error('Response is not a PNG')
    writeFileSync(outPng, image, { flag: 'wx' })
    Object.assign(record, { status: 'candidate-awaiting-review', file: outPng, outWidth: image.readUInt32BE(16), outHeight: image.readUInt32BE(20), sha256: createHash('sha256').update(image).digest('hex') })
  } catch (error) {
    if (record.status === 'request-started') record.status = 'outcome-unknown'
    const cause = error?.cause
    record.error = { name: String(error?.name ?? 'Error'), message: scrub(error?.message ?? error).slice(0, 500), ...(cause ? { cause: { code: cause.code ? String(cause.code) : undefined, message: scrub(cause.message ?? '').slice(0, 500) } } : {}) }
    process.exitCode = 1
  } finally {
    record.seconds = Math.round((performance.now() - started) / 100) / 10
    save()
    console.log(JSON.stringify({ status: record.status, httpStatus: record.httpStatus, contentType: record.contentType, file: record.file, size: record.outWidth ? `${record.outWidth}x${record.outHeight}` : undefined, seconds: record.seconds, ...(record.errorBody ? { errorBody: record.errorBody.slice(0, 300) } : {}), ...(record.error ? { error: record.error.cause?.code ?? record.error.name } : {}) }))
  }
}

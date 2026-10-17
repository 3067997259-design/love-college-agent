// 短片关键帧的 NovelAI 调用：一次只出一张图。NovelAI 条款要求每次生图都由人的操作发起，
// 所以这里没有批量模式，也不写循环；每次运行就是一次由人要求的请求（技术方案 §8）。
//
// 用法：
//   node film/nai.mjs gen <帧 id> [--seed N]   → film/gen/<帧 id>-<seed>.png，记录追加到 art/gen-log.jsonl
//   node film/nai.mjs lineart <图片路径>         → 同目录 <名>-lineart.png（Director Tools 线稿，免费）
//
// 凭据只在运行时从 secrets/novelai.json 读（LCA_NAI_SECRET 可指定路径）；不打印、不写盘、不进日志。
// 参数用美术规格 §2.3／§3.6 冻结的配方，标准尺寸、23 步，都在 Opus 免费范围内。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://image.novelai.net'
const sheet = JSON.parse(readFileSync(join(root, 'film', 'prompts.json'), 'utf8'))

/** 凭据：按 NovelAI 持久令牌的前缀 pst- 在文件里找（不看字段名、不输出任何值）；没有前缀时只接受唯一一条长字符串 */
function credential() {
  const path = process.env.LCA_NAI_SECRET ?? join(root, 'secrets', 'novelai.json')
  const text = readFileSync(path, 'utf8').trim()
  const strings = []
  const walk = (value) => { if (typeof value === 'string') strings.push(value.trim()); else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item) }
  try { walk(JSON.parse(text)) } catch { strings.push(text) }
  const bare = (value) => value.replace(/^Bearer\s+/i, '')
  const token = strings.map(bare).find((value) => value.startsWith('pst-')) ?? (strings.filter((value) => bare(value).length >= 32).length === 1 ? bare(strings.find((value) => bare(value).length >= 32)) : undefined)
  if (!token) throw new Error('凭据文件里没找到 NovelAI 令牌（pst- 开头，或唯一的一条长字符串）')
  return 'Bearer ' + token
}

async function post(path, body) {
  const started = performance.now()
  const response = await fetch(API + path, {
    method: 'POST',
    headers: { Authorization: credential(), 'Content-Type': 'application/json', Accept: 'application/zip' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`NovelAI ${response.status}：${(await response.text()).slice(0, 300)}`)
  const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()))
  const name = Object.keys(zip.files).find((file) => file.toLowerCase().endsWith('.png'))
  if (!name) throw new Error('返回的压缩包里没有 PNG')
  return { png: await zip.file(name).async('nodebuffer'), seconds: Math.round((performance.now() - started) / 100) / 10 }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const stamp = () => new Date().toISOString().slice(0, 19)
const pngSize = (buffer) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) })
function freePath(path) {
  if (!existsSync(path)) return path
  for (let index = 2; ; index++) { const next = path.replace(/(\.png)$/, `-${index}$1`); if (!existsSync(next)) return next }
}
function log(record) { appendFileSync(join(root, 'art', 'gen-log.jsonl'), JSON.stringify(record) + '\n') }

/** 一帧的提示词：画风 → 角色 → 服装 → 道具 → 镜头与姿势 → 表情 → 光 → 质量（美术规格 §2.3 的槽位顺序） */
function promptFor(frame) {
  const { slots } = sheet
  const parts = [slots.style]
  if (frame.character) parts.push(slots.character, slots[frame.outfit])
  for (const item of frame.with ?? []) parts.push(slots[item])
  parts.push(frame.scene)
  if (frame.expression) parts.push(frame.expression)
  parts.push(frame.light, slots.quality)
  const negative = !frame.character ? slots.negativeScenery
    : frame.allowBlush ? slots.negative.replace(/, blush$/, '') : slots.negative
  return { prompt: parts.join(', '), negative }
}

async function generate(id, seedArg) {
  const frame = sheet.frames[id]
  if (!frame) throw new Error(`没有这一帧：${id}（可选：${Object.keys(sheet.frames).join('、')}）`)
  const { prompt, negative } = promptFor(frame)
  const [width, height] = sheet.sizes[frame.size]
  const { model, sampler, steps, scale, noise_schedule: noiseSchedule } = sheet.params
  const seed = seedArg ?? frame.seed ?? sheet.params.seed
  const { png, seconds } = await post('/ai/generate-image', {
    input: prompt, model, action: 'generate',
    parameters: {
      params_version: 3, width, height, scale, sampler, steps, seed, n_samples: 1, ucPreset: 0, qualityToggle: false,
      noise_schedule: noiseSchedule, cfg_rescale: 0, sm: false, sm_dyn: false, dynamic_thresholding: false, legacy: false,
      add_original_image: true, deliberate_euler_ancestral_bug: false, prefer_brownian: true, negative_prompt: negative,
      v4_prompt: { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true },
      v4_negative_prompt: { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false },
    },
  })
  mkdirSync(join(root, 'film', 'gen'), { recursive: true })
  const file = freePath(join(root, 'film', 'gen', `${id}-${seed}.png`))
  writeFileSync(file, png)
  log({ time: stamp(), file: basename(file), sha256: sha256(png), model, seconds, prompt, negative, width, height, scale, steps, seed, sampler, frame: id, shot: frame.shot })
  console.log(`${basename(file)}  ${seconds}s  ${sha256(png).slice(0, 12)}`)
}

async function lineart(input) {
  const source = readFileSync(input)
  const { width, height } = pngSize(source)
  const { png, seconds } = await post('/ai/augment-image', { req_type: 'lineart', image: source.toString('base64'), width, height, prompt: '', defry: 0 })
  const file = freePath(join(dirname(input), basename(input, extname(input)) + '-lineart.png'))
  writeFileSync(file, png)
  log({ time: stamp(), file: basename(file), sha256: sha256(png), tool: 'augment:lineart', seconds, source: basename(input), source_sha256: sha256(source), width, height })
  console.log(`${basename(file)}  ${seconds}s`)
}

const [command, target, ...rest] = process.argv.slice(2)
const seedFlag = rest.indexOf('--seed')
const seed = seedFlag >= 0 ? Number(rest[seedFlag + 1]) : undefined
try {
  if (command === 'gen' && target) await generate(target, Number.isFinite(seed) ? seed : undefined)
  else if (command === 'lineart' && target) await lineart(resolve(target))
  else throw new Error('用法：node film/nai.mjs gen <帧 id> [--seed N] | lineart <图片路径>')
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
  process.exitCode = 1
}

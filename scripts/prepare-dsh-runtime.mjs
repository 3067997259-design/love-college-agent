// Prepares the DeepSeek Harness runtime LCA ships (dsh/runtime): installs the pinned @deepseek-ai/dsh from
// the committed lockfile without install scripts, drops payloads LCA does not use by default, trims files
// that are never loaded at runtime, and writes THIRD_PARTY_NOTICES.txt for every package that ships.
// Usage: node scripts/prepare-dsh-runtime.mjs [--skip-install]
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(import.meta.dirname, '..')
const runtime = join(root, 'dsh', 'runtime')
const modules = join(runtime, 'node_modules')

// Never loaded by LCA's headless `lca` profile (traced over the bridge-check scenarios):
// - platform payloads of optional features: office conversion (LibreOffice, ~180 MB), speech recognition;
// - DSH's own web client and inspector: LCA drives DSH over IPC and draws its own book.
// DSH's tools, providers, MCP client, skills, subagents and plugin manager all stay.
const DROP_PACKAGES = [/^@deepseek-ai\/libreoffice-kit-(darwin|linux|win32|wasm)/, /^sherpa-onnx-(darwin|linux|win)-/, /^@img\/sharp-wasm32$/,
  /^@deepseek-ai\/dsh-(experimental-)?client-ui-/, /^@deepseek-ai\/dsh-experimental-(session-)?inspector$/, /^@deepseek-ai\/dsh-web-(app|frontend)$/]
// node-pty ships prebuilt binaries for every platform; keep this one.
const PTY_KEEP = `${process.platform}-${process.arch}`
// Never loaded at runtime. READMEs of DSH's own packages stay: its plugin tooling reads them.
const DROP_FILE = /\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/i
const DROP_ROOT_FILE = /^(readme|changelog|history|contributing)(\.[\w.-]+)?$/i
const DROP_DIR = new Set(['test', 'tests', '__tests__', '.github', 'example', 'examples', 'benchmark', 'benchmarks'])
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.[\w.-]+)?$/i

if (!process.argv.includes('--skip-install')) {
  const env = runtimeEnv(root)
  if (env.HTTP_PROXY || env.HTTPS_PROXY) env.NODE_USE_ENV_PROXY = '1'
  execSync('npm ci --ignore-scripts --omit=dev --no-audit --no-fund', { cwd: runtime, env, stdio: 'inherit' })
}

/** Every installed package directory, including nested node_modules. */
function packages(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    const path = join(dir, entry.name)
    if (entry.name.startsWith('@')) { packages(path, out); continue }
    if (existsSync(join(path, 'package.json'))) { out.push(path); packages(join(path, 'node_modules'), out) }
  }
  return out
}
const nameOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name ?? '' } catch { return '' } }

let dropped = []
for (const dir of packages(modules)) {
  const name = nameOf(dir)
  if (DROP_PACKAGES.some((pattern) => pattern.test(name))) { rmSync(dir, { recursive: true, force: true }); dropped.push(name); continue }
  if (name === 'node-pty' && existsSync(join(dir, 'prebuilds'))) {
    for (const target of readdirSync(join(dir, 'prebuilds'))) if (target !== PTY_KEEP) rmSync(join(dir, 'prebuilds', target), { recursive: true, force: true })
  }
}

let removedFiles = 0
function trim(dir, packageRoot, ownPackage) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      if (DROP_DIR.has(entry.name)) { rmSync(path, { recursive: true, force: true }); removedFiles++; continue }
      trim(path, packageRoot, ownPackage)
    } else if (DROP_FILE.test(entry.name) || (dir === packageRoot && !ownPackage && DROP_ROOT_FILE.test(entry.name))) {
      rmSync(path, { force: true }); removedFiles++
    }
  }
}
const shipped = packages(modules)
for (const dir of shipped) trim(dir, dir, nameOf(dir).startsWith('@deepseek-ai/'))

// Notices: one entry per shipped package, with its license files verbatim.
const seen = new Set()
const entries = []
for (const dir of shipped) {
  let meta
  try { meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { continue }
  const id = `${meta.name}@${meta.version}`
  if (seen.has(id)) continue
  seen.add(id)
  const license = typeof meta.license === 'string' ? meta.license : meta.license?.type ?? 'UNKNOWN'
  const texts = readdirSync(dir).filter((file) => LICENSE_FILE.test(file) && statSync(join(dir, file)).isFile()).map((file) => readFileSync(join(dir, file), 'utf8').trim())
  entries.push({ id, license, texts })
}
entries.sort((a, b) => a.id.localeCompare(b.id))
const dsh = JSON.parse(readFileSync(join(modules, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
writeFileSync(join(runtime, 'THIRD_PARTY_NOTICES.txt'), [
  `DeepSeek Harness ${dsh} runtime shipped with Love, College & Agent.`,
  'DeepSeek Harness: MIT License, https://github.com/deepseek-ai/deepseek-harness',
  `${entries.length} packages follow, each with the license files it ships.`,
  ...entries.map((entry) => ['', '-'.repeat(72), `${entry.id} (${entry.license})`, ...(entry.texts.length ? entry.texts : ['(no license file in the package; see its license field above)'])].join('\n')),
].join('\n') + '\n')

let files = 0; let bytes = 0
;(function count(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) count(path); else if (entry.isFile()) { files++; bytes += statSync(path).size } } })(modules)
const unknown = entries.filter((entry) => entry.license === 'UNKNOWN').map((entry) => entry.id)
console.log(JSON.stringify({ dsh, packages: entries.length, dropped, removedFiles, files, megabytes: Math.round(bytes / 1048576), unknownLicense: unknown }, null, 2))

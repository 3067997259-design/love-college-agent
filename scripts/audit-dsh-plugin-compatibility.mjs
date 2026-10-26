// Metadata-only admission characterization. Never installs or imports third-party plugin code.
// Usage: node scripts/audit-dsh-plugin-compatibility.mjs [absolute-output.json]
import { build } from 'vite'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'lca-plugin-compatibility-'))
const fixture = resolve(repo, 'docs/research/evidence/dsh-plugin-samples-20261026.json')
const sha256 = (file) => createHash('sha256').update(readFileSync(resolve(repo, file))).digest('hex')
await build({ configFile: false, logLevel: 'error',
  resolve: { alias: { yaml: resolve(repo, 'dsh/runtime/node_modules/yaml/dist/index.js') } },
  build: { ssr: resolve(repo, 'scripts/fixtures/dsh-plugin-compatibility-probe.ts'), outDir: root,
    emptyOutDir: false, minify: false, rollupOptions: { output: { entryFileNames: 'probe.mjs' } } },
})
const { probe } = await import(pathToFileURL(join(root, 'probe.mjs')).href)
const { default: semver } = await import(pathToFileURL(resolve(repo, 'dsh/runtime/node_modules/semver/index.js')).href)
const source = JSON.parse(readFileSync(fixture, 'utf8'))
const runtime = JSON.parse(readFileSync(resolve(repo, 'dsh/runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
const result = await probe(root, repo, source.samples)
const evidence = { schema: 1, observedDate: '2026-10-26',
  scope: 'Production candidate selection and patch validation with a non-executing plugin-manager double. No upstream JS, pnpm operation, DSH host, model, or external service is executed.',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  trackedDirty: execFileSync('git', ['status', '--porcelain', '-uno'], { cwd: repo, encoding: 'utf8' }).trim().length > 0,
  runtime, node: process.version, platform: process.platform, arch: process.arch,
  inputs: Object.fromEntries(['src/main/dsh/extensions.ts', 'dsh/lca-bridge/extensions.js', 'dsh/lca-bridge/profile.js',
    'dsh/lca-bridge/extension-files.js', 'dsh/lca-bridge/policy.js', 'scripts/audit-dsh-plugin-compatibility.mjs',
    'scripts/fixtures/dsh-plugin-compatibility-probe.ts', 'docs/research/evidence/dsh-plugin-samples-20261026.json'].map(p => [p, sha256(p)])),
  peerDeclarations: source.samples.flatMap(s => Object.entries(JSON.parse(s.manifestText).peerDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-')).map(([name, range]) => ({ sample: s.id, name, range, runtime,
      declaredCompatible: semver.satisfies(runtime, range), note: 'Declaration only; this does not establish an actual ABI failure.' }))),
  ...result }
const output = process.argv[2] ? resolve(process.argv[2]) : join(root, 'evidence.json')
writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ root, output, checks: evidence.checks, modelRequests: 0, packageManagerRuns: 0, thirdPartyCodeExecuted: false }, null, 2))

// Prepares the DSH profile LCA launches: `$DSH_HOME/profiles/lca` composes dsh-base with the
// lca-bridge bundle, linked from this repository as an out-of-tree plugin.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function prepareDshProfile({ dshRoot, dataDir, bridge }) {
  const home = join(dataDir, 'dsh-home')
  const profile = join(home, 'profiles', 'lca')
  const manifest = { name: 'dsh-profile-lca', private: true, dependencies: { '@lca/dsh-bridge': `link:${bridge.replaceAll('\\', '/')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@lca/dsh-bridge'] } } }
  mkdirSync(profile, { recursive: true })
  const manifestPath = join(profile, 'package.json')
  const text = JSON.stringify(manifest, null, 2) + '\n'
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== text) writeFileSync(manifestPath, text)
  if (!existsSync(join(profile, 'cordis.patch.yml'))) writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  if (!existsSync(join(profile, 'pnpm-workspace.yaml'))) writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const link = join(profile, 'node_modules', '@lca', 'dsh-bridge')
  if (!existsSync(link)) { mkdirSync(dirname(link), { recursive: true }); symlinkSync(bridge, link, 'junction') }
  return { home, profile, cli: join(dshRoot, 'apps', 'cli', 'lib', 'bin.js') }
}

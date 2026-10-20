// Prepares the DSH profile LCA launches: `$DSH_HOME/profiles/lca` composes dsh-base with the
// lca-bridge bundle, linked from this repository as an out-of-tree plugin.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** DSH's CLI: the pinned npm runtime (dsh/runtime, shipped with the app) or a built checkout of the fork. */
export const dshCli = (root) => { const npm = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'); return existsSync(npm) ? npm : join(root, 'apps', 'cli', 'lib', 'bin.js') }

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
  // Re-link when the bridge moved (a checkout in development, the app's resources once installed).
  let linked = null; let present = false
  try { const stat = lstatSync(link); present = true; if (stat.isSymbolicLink()) linked = resolve(readlinkSync(link)) } catch { /* not linked yet */ }
  if (linked !== resolve(bridge)) {
    // unlink, not rm: Electron's Node refuses rmSync on a directory junction (ERR_FS_EISDIR).
    if (present) unlinkSync(link)
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(bridge, link, 'junction')
  }
  return { home, profile, cli: dshCli(dshRoot) }
}

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { dshCli } from './host'

/**
 * Where the DSH runtime and LCA's bridge live: beside the asar once installed (resources/dsh-runtime and
 * resources/lca-bridge, see electron-builder.yml), in the checkout during development. DSH_ROOT points at
 * another runtime, such as a built checkout of the fork.
 */
export function dshLocations() {
  const root = process.env.DSH_ROOT ?? (app.isPackaged ? join(process.resourcesPath, 'dsh-runtime') : join(app.getAppPath(), 'dsh', 'runtime'))
  const bridge = app.isPackaged ? join(process.resourcesPath, 'lca-bridge') : join(app.getAppPath(), 'dsh', 'lca-bridge')
  return { root, bridge, present: existsSync(dshCli(root)) && existsSync(join(bridge, 'index.js')) }
}

import { lstatSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
const key = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
/** Refuse links before reading/writing, including links above the root. */
export function assertSkillPath(path, root) {
  if (key(path) !== key(root) && !key(path).startsWith(key(root) + sep)) throw new Error('SKILL_OUTSIDE_ROOT')
  for (let at = resolve(path); ; at = dirname(at)) {
    try { if (lstatSync(at).isSymbolicLink()) throw new Error('SKILL_LINK') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (dirname(at) === at) break
  }
}

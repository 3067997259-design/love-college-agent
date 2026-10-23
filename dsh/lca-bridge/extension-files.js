import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A local candidate is copied into the private data root before approval; links are never followed.
export function fingerprintDirectory(root) {
  const hash = createHash('sha256'); let bytes = 0, files = 0
  const walk = (dir, relative = '') => {
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('EXTENSION_INVALID')
    for (const name of readdirSync(dir).sort()) {
      if (['node_modules', '.git'].includes(name)) continue
      const path = join(dir, name), key = `${relative}/${name}`, stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('EXTENSION_INVALID')
      if (stat.isDirectory()) walk(path, key)
      else if (stat.isFile()) {
        if (++files > 5000 || (bytes += stat.size) > 50 * 1024 * 1024) throw new Error('EXTENSION_TOO_LARGE')
        hash.update(JSON.stringify(key)); hash.update(String(stat.size)); hash.update(readFileSync(path))
      } else throw new Error('EXTENSION_INVALID')
    }
  }
  walk(root); return hash.digest('hex')
}

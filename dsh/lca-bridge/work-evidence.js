import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const canonical = path => { const value = realpathSync.native(path); return process.platform === 'win32' ? value.toLowerCase() : value }
const inside = (child, root) => child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)

/** Read only bounded regular files inside the canonical project. No content is
 * returned, and a symlink cannot turn an artifact claim into a private-file read. */
export function captureWorkFile(cwd, file) {
  if (typeof file !== 'string' || !file.trim()) return null
  try {
    const root = canonical(cwd), path = resolve(cwd, file)
    const rel = relative(resolve(cwd), path)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return null
    if (!existsSync(path)) {
      if (!inside(canonical(dirname(path)), root)) return null
      return { relativePath: rel.replaceAll('\\', '/'), hash: null, bytes: null }
    }
    if (!inside(canonical(path), root)) return null
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    const data = readFileSync(path)
    if (data.byteLength !== stat.size || data.byteLength > MAX_FILE_BYTES) return null
    return { relativePath: rel.replaceAll('\\', '/'), hash: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength }
  } catch { return null }
}

export function verifyWorkFile(cwd, evidence) {
  if (!evidence.relativePath || !evidence.afterHash) return false
  const actual = captureWorkFile(cwd, evidence.relativePath)
  return !!actual && actual.hash === evidence.afterHash && actual.bytes === evidence.bytes
}

/** Successful transport/exit of a background shell job is not its completion. */
export function commandObservation(name, result) {
  if (!['pwsh', 'bash'].includes(name)) return null
  const value = result?.value
  const terminal = value?.kind === 'foreground' && Number.isSafeInteger(value.exitCode) && !value.timedOut && !value.aborted && !value.signal
  return { kind: 'command', status: result?.isError || value?.timedOut || value?.aborted || terminal && value.exitCode !== 0 ? 'failed' : terminal ? 'passed' : 'unverified',
    exitCode: terminal ? value.exitCode : null }
}

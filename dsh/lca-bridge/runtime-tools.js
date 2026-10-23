import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const marker = '@rem LCA_NODE_SHIM_V1'
const stat = (file) => { try { return lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

/** Only approved package-manager subprocesses receive this PATH; it is never installed globally. */
export function packageManagerEnvironment(profile, executable = process.execPath) {
  const env = { ELECTRON_RUN_AS_NODE: '1', npm_config_manage_package_manager_versions: 'false' }
  if (process.platform !== 'win32') return env
  if (/["\r\n]/.test(executable)) throw new Error('LCA_RUNTIME_EXECUTABLE_INVALID')
  const bin = join(profile, '.lca-runtime-bin'), directory = stat(bin)
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) throw new Error('LCA_RUNTIME_TOOL_CONFLICT')
  if (!directory) mkdirSync(bin)
  const file = join(bin, 'node.cmd'), current = stat(file)
  if (current && (!current.isFile() || current.isSymbolicLink() || !readFileSync(file, 'utf8').startsWith(marker + '\r\n'))) throw new Error('LCA_RUNTIME_TOOL_CONFLICT')
  // Electron's binary has the app's name. pnpm runs on it already, but lifecycle commands such as
  // "node build.js" need a command named node. Disable ! expansion and escape literal % in the path.
  const content = `${marker}\r\n@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${executable.replaceAll('%', '%%')}" %*\r\nexit /b %errorlevel%\r\n`
  if (!current || readFileSync(file, 'utf8') !== content) {
    const temp = `${file}.${randomUUID()}.tmp`
    let created = false
    try { writeFileSync(temp, content, { flag: 'wx', mode: 0o600 }); created = true; renameSync(temp, file); created = false }
    finally { if (created) unlinkSync(temp) }
  }
  const path = [bin, process.env.Path ?? process.env.PATH ?? ''].filter(Boolean).join(';')
  return { ...env, Path: path, PATH: path }
}

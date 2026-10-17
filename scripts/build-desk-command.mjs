import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeEnv } from './runtime-env.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export async function buildDeskCommand() {
  if (process.platform !== 'win32') return // Runtime remains unavailable on other systems; no unsandboxed fallback.
  const output = join(root, 'out', 'native'); await mkdir(output, { recursive: true })
  const source = join(root, 'native', 'desk-command', 'DeskCommand.cs'); const exe = join(output, 'DeskCommand.exe')
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  await new Promise((done, reject) => execFile(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', '/out:' + exe, source], { windowsHide: true, env: runtimeEnv(root) }, (error, stdout) => error ? reject(new Error('DESK_COMMAND_BUILD_FAILED: ' + stdout)) : done()))
  const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
  await writeFile(join(output, 'desk-command.json'), JSON.stringify({ version: 1, sourceSha256: await sha(source), executableSha256: await sha(exe) }) + '\n')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildDeskCommand()

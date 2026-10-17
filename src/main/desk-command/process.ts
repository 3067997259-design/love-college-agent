import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { StringDecoder } from 'node:string_decoder'
import type { Clock } from '../clock'

const outcome = z.strictObject({ status: z.enum(['completed', 'cancelled', 'timeout', 'output-limit']), exitCode: z.number().int().nullable(), stdout: z.string().max(65536), stderr: z.string().max(65536), appContainer: z.literal(true), networkCapabilities: z.literal(0), processTreeTerminated: z.literal(true), elapsedMs: z.number().int().nonnegative() })
export type CommandProcessResult = z.infer<typeof outcome>
export class CommandProcessFailure extends Error {
  constructor(readonly stage: string, readonly nativeCode?: number) { super('COMMAND_EXECUTOR_FAILED') }
}
const nativeFailure = z.strictObject({ status: z.literal('unavailable'), stage: z.enum(['input', 'profile', 'acl', 'label-descriptor', 'label-sacl', 'label-apply', 'runtime-directory', 'job', 'pipes', 'attributes', 'launch', 'token']), error: z.string().regex(/^(?:(?:win32|hresult)--?\d+|sandbox-unavailable)$/) })
export interface CommandProcessPort {
  available(): boolean
  run(input: { root: string; command: string; timeoutMs: number }, signal: AbortSignal): Promise<CommandProcessResult>
}
/** No inherited secret-bearing environment and no direct/unsandboxed fallback. */
export function createCommandProcess(executable: string, clock: Clock): CommandProcessPort {
  const verified = () => {
    if (process.platform !== 'win32' || process.arch !== 'x64') return false
    try {
      const path = resolve(executable); const stat = lstatSync(path); const receiptPath = join(dirname(path), 'desk-command.json')
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2_000_000 || realpathSync(path) !== path || lstatSync(receiptPath).isSymbolicLink() || lstatSync(receiptPath).size > 1024) return false
      const receipt = z.strictObject({ version: z.literal(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), executableSha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(readFileSync(receiptPath, 'utf8')))
      return createHash('sha256').update(readFileSync(path)).digest('hex') === receipt.executableSha256
    } catch { return false }
  }
  const environment = () => Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []))
  const cleanup = (profile: string) => new Promise<void>((done, reject) => {
    if (!/^lca\.desk\.[a-f0-9]{32}$/.test(profile)) { reject(new Error('COMMAND_PROFILE_INVALID')); return }
    const child = spawn(executable, ['--cleanup', profile], { windowsHide: true, env: environment(), stdio: ['ignore', 'pipe', 'ignore'] })
    let bytes = 0; let data = ''; child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024) child.kill(); else data += chunk.toString('utf8') })
    const cancel = clock.after(3000, () => child.kill())
    child.on('error', () => { cancel(); reject(new Error('COMMAND_CLEANUP_FAILED')) }); child.on('close', (code) => { cancel(); if (code === 0 && data.trim() === '{"profileRemoved":true}') done(); else reject(new Error('COMMAND_CLEANUP_FAILED')) })
  })
  return { available: verified, run: async (input, signal) => {
    signal.throwIfAborted(); if (!verified()) throw new Error('COMMAND_UNAVAILABLE')
    return new Promise<CommandProcessResult>((done, reject) => {
      const child = spawn(executable, [], { windowsHide: true, env: environment(), stdio: ['pipe', 'pipe', 'ignore'] })
      let profile: string | undefined; let result: CommandProcessResult | undefined; let bytes = 0; let buffered = ''; let invalid = false; let forced = false
      const decoder = new StringDecoder('utf8')
      let failure: CommandProcessFailure | undefined
      let hardStop: (() => void) | undefined
      const kill = () => { forced = true; child.kill() }
      const stop = () => { if (!hardStop) { child.stdin.write('cancel\n'); hardStop = clock.after(2500, kill) } }
      child.stdin.on('error', () => {})
      const deadline = clock.after(input.timeoutMs + 6000, kill)
      signal.addEventListener('abort', stop, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length; if (bytes > 500_000) { invalid = true; kill(); return }
        buffered += decoder.write(chunk)
        for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
          const line = buffered.slice(0, index).trim(); buffered = buffered.slice(index + 1)
          try {
            const value: unknown = JSON.parse(line)
            const info = z.strictObject({ kind: z.literal('profile'), name: z.string().regex(/^lca\.desk\.[a-f0-9]{32}$/) }).safeParse(value)
            const failed = nativeFailure.safeParse(value)
            if (info.success && !profile && !result) profile = info.data.name
            else if (failed.success && !result) failure = new CommandProcessFailure(failed.data.stage, failed.data.error.startsWith('win32-') ? Number(failed.data.error.slice(6)) : failed.data.error.startsWith('hresult-') ? Number(failed.data.error.slice(8)) : undefined)
            else if (profile && !result) result = outcome.parse(value)
            else throw new Error('COMMAND_PROTOCOL_INVALID')
          } catch { invalid = true; kill() }
        }
      })
      child.on('error', () => { invalid = true })
      child.on('close', () => {
        buffered += decoder.end()
        deadline(); hardStop?.(); signal.removeEventListener('abort', stop); child.stdin.end()
        void (async () => {
          if ((forced || invalid || !result) && profile) { try { await cleanup(profile) } catch { if (!failure) failure = new CommandProcessFailure('cleanup') } }
          if (failure) throw failure
          if (invalid || !result || buffered.trim()) throw new CommandProcessFailure(forced ? 'host-timeout' : 'protocol')
          done(signal.aborted ? { ...result, status: 'cancelled', exitCode: null } : result)
        })().catch((error) => reject(error instanceof CommandProcessFailure ? error : new CommandProcessFailure('host')))
      })
      child.stdin.write(JSON.stringify(input) + '\n'); if (signal.aborted) stop()
    })
  } }
}

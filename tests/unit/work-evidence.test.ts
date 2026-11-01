import { describe, expect, it } from 'vitest'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWorkFile, verifyWorkFile, commandObservation } from '../../dsh/lca-bridge/work-evidence.js'

describe('executor evidence rather than accepted commands', () => {
  it('hashes actual bytes, detects changes, and refuses outside or linked-outside paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'lca-proof-')), outside = mkdtempSync(join(tmpdir(), 'lca-proof-outside-'))
    expect(captureWorkFile(root, 'output.txt')).toMatchObject({ hash: null, bytes: null })
    writeFileSync(join(root, 'output.txt'), 'Actual output')
    const captured = captureWorkFile(root, 'output.txt')!
    const evidence = { relativePath: 'output.txt', afterHash: captured.hash, bytes: captured.bytes }
    expect(verifyWorkFile(root, evidence)).toBe(true)
    writeFileSync(join(root, 'output.txt'), 'Changed output'); expect(verifyWorkFile(root, evidence)).toBe(false)
    writeFileSync(join(outside, 'private.txt'), 'Private outside data')
    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(captureWorkFile(root, join(outside, 'private.txt'))).toBeNull()
    expect(captureWorkFile(root, 'escape/private.txt')).toBeNull()
    expect(captureWorkFile(root, '.')).toBeNull()
  })

  it('requires a terminal zero exit, with background, aborted and failed commands distinct', () => {
    expect(commandObservation('pwsh', { value: { kind: 'foreground', exitCode: 0 } })).toMatchObject({ status: 'passed', exitCode: 0 })
    expect(commandObservation('bash', { value: { kind: 'background', exitCode: 0 } })).toMatchObject({ status: 'unverified', exitCode: null })
    expect(commandObservation('pwsh', { value: { kind: 'foreground', exitCode: 1 } })).toMatchObject({ status: 'failed', exitCode: 1 })
    expect(commandObservation('pwsh', { value: { kind: 'foreground', exitCode: 0, aborted: true } })).toMatchObject({ status: 'failed', exitCode: null })
    expect(commandObservation('write', { value: 'accepted' })).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'
import { validatePrivateSave, sha256 } from '../../src/main/backup/archive'
import { DATABASES } from '../../src/main/backup/schema'
import { idleTimer } from '../../src/main/pomodoro/schema'
import type { JournalInput } from '../../src/main/journal/schema'

const owner = { userId: 'test-user', characterId: 'test-character' }
async function fixture(events: JournalInput[] = []) {
  const journal = Buffer.from([{ type: 'session/header', ...owner, sessionId: 'session' }, ...events].map((row, index) => JSON.stringify({ ...row, version: 1, seq: index + 1, atMs: 1000 })).join('\n') + '\n')
  const key = sha256(JSON.stringify([owner.userId, owner.characterId])); const files = new Map<string, Buffer>([['journals/' + key + '/2026-10-16.jsonl', journal], ...DATABASES.map((name): [string, Buffer] => [name, Buffer.from('schema validation belongs to native SQLite stage')])])
  const manifest = { formatVersion: 1, kind: 'lca-private-save', archiveId: randomUUID(), savedAtMs: 1000, owner, source: 'fake', activeDayKey: '2026-10-16', activeSessionId: 'session', pomodoro: idleTimer(), pomodoroPause: null, fileFilteringEnabled: false,
    counts: { pageCount: 1, messageCount: 0, memoryCount: 0, deliveryCount: 0 }, files: [...files].map(([path, data]) => ({ path, bytes: data.length, sha256: sha256(data) })) }
  const zip = new JSZip(); zip.file('manifest.json', JSON.stringify(manifest), { createFolders: false }); for (const [path, bytes] of files) zip.file(path, bytes, { createFolders: false })
  return { manifest, zip, bytes: () => zip.generateAsync({ type: 'nodebuffer' }) }
}
describe('untrusted private-save validation before touching current data', () => {
  it('binds photo dimensions and provenance to its actual PNG and owning journal page', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=', 'base64')
    const asset = { ref: 'asset:' + sha256(png), sha256: sha256(png), format: 'png' as const, byteLength: png.length }; const path = 'artifacts/' + asset.sha256 + '.png'
    for (const change of [{}, { width: 2 }, { sessionId: 'other-session' }, { dayKey: '2026-10-15' }]) {
      const f = await fixture([{ type: 'asset/stored', asset }, { type: 'history/photo', photo: { id: randomUUID(), sessionId: 'session', dayKey: '2026-10-16', reason: 'manual', eventId: 'manual', asset, width: 1, height: 1, ...change } }])
      f.zip.file(path, png, { createFolders: false }); f.manifest.files.push({ path, bytes: png.length, sha256: asset.sha256 }); f.zip.file('manifest.json', JSON.stringify(f.manifest))
      const checked = validatePrivateSave(await f.bytes(), owner, 'fake')
      if (Object.keys(change).length) await expect(checked).rejects.toMatchObject({ code: 'backup-invalid' })
      else await expect(checked).resolves.toHaveProperty('manifest')
    }
  })
  it('rejects non-replayable applied desk snapshots but preserves failed legacy intents', async () => {
    for (const invalid of [{ path: 'a.txt', after: '字'.repeat(22_000) }, { path: 'a.txt', after: 'short\0text' }, { path: '../outside', after: 'text' }, { path: 'a.txt', after: '\ud800' }]) {
      const change: JournalInput = { type: 'desk/change', id: 'write', flowId: 'flow', before: null, ...invalid }
      for (const events of [[change], [{ ...change, pending: true }, { type: 'desk/settled', id: 'write', status: 'applied' }]] as JournalInput[][]) {
        const f = await fixture(events); await expect(validatePrivateSave(await f.bytes(), owner, 'fake')).rejects.toMatchObject({ code: 'backup-invalid' })
      }
      const failed = await fixture([{ ...change, pending: true }, { type: 'desk/settled', id: 'write', status: 'failed' }])
      await expect(validatePrivateSave(await failed.bytes(), owner, 'fake')).resolves.toHaveProperty('manifest')
    }
  })
  it('preserves a completed onboarding profile and validates untrusted names and status', async () => {
    const f = await fixture(); const onboarding = { status: 'completed', userName: '小林', characterName: '小桃', completedAtMs: 1000 }
    f.zip.file('manifest.json', JSON.stringify({ ...f.manifest, onboarding }))
    expect((await validatePrivateSave(await f.bytes(), owner, 'fake')).manifest.onboarding).toEqual(onboarding)
    for (const invalid of [{ ...onboarding, userName: '字'.repeat(21) }, { ...onboarding, characterName: 'a\nb' }, { ...onboarding, status: 'needed' }]) {
      f.zip.file('manifest.json', JSON.stringify({ ...f.manifest, onboarding: invalid })); await expect(validatePrivateSave(await f.bytes(), owner, 'fake')).rejects.toMatchObject({ code: 'backup-invalid' })
    }
  })
  it('validates the complete manifest and rejects a different user, character, or fake/real mode', async () => {
    const f = await fixture(); const bytes = await f.bytes(); expect((await validatePrivateSave(bytes, owner, 'fake')).files.size).toBe(5)
    for (const other of [{ ...owner, userId: 'other' }, { ...owner, characterId: 'other' }]) await expect(validatePrivateSave(bytes, other, 'fake')).rejects.toMatchObject({ code: 'backup-scope-mismatch' })
    await expect(validatePrivateSave(bytes, owner, 'real')).rejects.toMatchObject({ code: 'backup-scope-mismatch' })
  })
  it('refuses a tampered file and a misleading incoming summary', async () => {
    const f = await fixture(); f.zip.file(f.manifest.files[0].path, 'corruption', { createFolders: false })
    await expect(validatePrivateSave(await f.bytes(), owner, 'fake')).rejects.toMatchObject({ code: 'backup-invalid' })
    const other = await fixture(); other.manifest.counts.messageCount = 999; other.zip.file('manifest.json', JSON.stringify(other.manifest))
    await expect(validatePrivateSave(await other.bytes(), owner, 'fake')).rejects.toMatchObject({ code: 'backup-invalid' })
  })
  it('rejects zip-slip paths, symlinks, credentials files and missing required databases', async () => {
    for (const name of ['../escape', '/absolute', 'C:drive', 'secrets/providers.json']) {
      const f = await fixture(); f.zip.file(name, 'untrusted', { createFolders: false })
      await expect(validatePrivateSave(await f.bytes(), owner, 'fake')).rejects.toMatchObject({ code: 'backup-invalid' })
    }
    const link = await fixture(); link.zip.file('link', 'target', { unixPermissions: 0xa1ff, createFolders: false })
    await expect(validatePrivateSave(await link.zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }), owner, 'fake')).rejects.toMatchObject({ code: 'backup-invalid' })
    const missing = await fixture(); missing.zip.remove('documents.sqlite'); missing.manifest.files = missing.manifest.files.filter((file) => file.path !== 'documents.sqlite'); missing.zip.file('manifest.json', JSON.stringify(missing.manifest))
    await expect(validatePrivateSave(await missing.bytes(), owner, 'fake')).rejects.toMatchObject({ code: 'backup-invalid' })
  })
  it('rejects oversized expansion from the central directory before inflating any entry', async () => {
    const f = await fixture(); const bytes = await f.bytes(); const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); expect(central).toBeGreaterThan(0)
    bytes.writeUInt32LE(0x7fffffff, central + 24)
    await expect(validatePrivateSave(bytes, owner, 'fake')).rejects.toMatchObject({ code: 'backup-invalid' })
  })
})

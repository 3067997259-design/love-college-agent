import Database from 'better-sqlite3'
import JSZip from 'jszip'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../clock'
import type { SessionStore } from '../store/session'
import type { OnboardingView } from '../../shared'
import { assetPath, validateGlb } from '../storage/assets'
import { parseJournalContent, journalLocation } from '../journal/file'
import { projectJournal } from '../journal/projection'
import { projectMemory } from '../memory/projection'
import { DATABASES, BackupFailure, MAX_ARCHIVE_BYTES, MAX_UNPACKED_BYTES, manifestSchema, type SaveManifest } from './schema'
import { directory, privateWriteParent, regular } from './paths'
import { validateDeskChanges } from '../heart-flow/changes'

export const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const ownerKey = (owner: SaveManifest['owner']) => sha256(JSON.stringify([owner.userId, owner.characterId]))
const validPath = (path: string, key: string) => (DATABASES as readonly string[]).includes(path) || new RegExp('^journals/' + key + '/\\d{4}-\\d{2}-\\d{2}\\.jsonl$').test(path) || /^artifacts\/[a-f0-9]{64}\.(md|ics|glb|png|jpg|webp|zip)$/.test(path)
const tableSchemas: Record<typeof DATABASES[number], Record<string, readonly string[]>> = {
  'projections.sqlite': { session_projections: ['user_id', 'character_id', 'session_id', 'journal_seq', 'state_json'] },
  'campus.sqlite': { private_mail_evidence: ['owner', 'ref', 'content_hash', 'source_key', 'payload', 'quotes'], campus_projections: ['owner', 'record_count', 'state_json'] },
  'documents.sqlite': { private_documents: ['owner', 'ref', 'hash', 'format', 'bytes'] },
  'memory.sqlite': { memory_projection: ['owner', 'record_count', 'state_json'] },
}
export function checkDatabase(path: string, name: typeof DATABASES[number], owner: SaveManifest['owner'], prune = false, allowOtherOwners = false) {
  const db = new Database(path, { readonly: !prune, fileMustExist: true })
  try {
    db.pragma('trusted_schema = OFF')
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new BackupFailure('backup-invalid')
    const schema = tableSchemas[name]
    const objects = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as { type: string; name: string }[]
    if (objects.some((entry) => entry.type !== 'table' || !(entry.name in schema))) throw new BackupFailure('backup-invalid')
    if ((db.prepare("SELECT sql FROM sqlite_schema WHERE type='table'").all() as { sql: string }[]).some((row) => /\b(CHECK|REFERENCES|GENERATED|VIRTUAL|DEFAULT)\b/i.test(row.sql))) throw new BackupFailure('backup-invalid')
    for (const [table, columns] of Object.entries(schema)) {
      const actual = db.pragma('table_info(' + table + ')') as { name: string }[]
      if (JSON.stringify(actual.map((column) => column.name)) !== JSON.stringify(columns)) throw new BackupFailure('backup-invalid')
      // Identifiers above are program constants, never archive SQL or user-provided table names.
      const predicate = name === 'projections.sqlite' ? 'user_id<>? OR character_id<>?' : 'owner<>?'
      const args = name === 'projections.sqlite' ? [owner.userId, owner.characterId] : [ownerKey(owner)]
      if (prune) db.prepare('DELETE FROM ' + table + ' WHERE ' + predicate).run(...args)
      else if (!allowOtherOwners && (db.prepare('SELECT count(*) AS count FROM ' + table + ' WHERE ' + predicate).get(...args) as { count: number }).count) throw new BackupFailure('backup-scope-mismatch')
    }
    if (prune) { db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)') }
  } finally { db.close() }
}
export function mergeOtherOwners(path: string, previous: string, name: typeof DATABASES[number], owner: SaveManifest['owner']) {
  checkDatabase(previous, name, owner, false, true)
  const source = new Database(previous, { readonly: true, fileMustExist: true }); const target = new Database(path, { fileMustExist: true })
  try {
    source.pragma('trusted_schema = OFF'); target.pragma('trusted_schema = OFF')
    target.transaction(() => {
      for (const [table, columns] of Object.entries(tableSchemas[name])) {
        const predicate = name === 'projections.sqlite' ? 'user_id<>? OR character_id<>?' : 'owner<>?'
        const args = name === 'projections.sqlite' ? [owner.userId, owner.characterId] : [ownerKey(owner)]
        const insert = target.prepare('INSERT INTO ' + table + ' VALUES (' + columns.map(() => '?').join(',') + ')')
        for (const row of source.prepare('SELECT * FROM ' + table + ' WHERE ' + predicate).all(...args) as Record<string, unknown>[]) insert.run(...columns.map((column) => row[column]))
      }
    })(); target.pragma('wal_checkpoint(TRUNCATE)')
  } finally { source.close(); target.close() }
}
function noCredentials(bytes: Buffer, credentials: readonly string[]) {
  if (credentials.some((secret) => secret.length >= 8 && bytes.includes(Buffer.from(secret)))) throw new BackupFailure('export-failed')
}
function inspectZip(bytes: Buffer) {
  if (bytes.length > MAX_ARCHIVE_BYTES || bytes.length < 22) throw new BackupFailure('file-too-large')
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new BackupFailure('backup-invalid')
  const count = bytes.readUInt16LE(end + 10); const size = bytes.readUInt32LE(end + 12); const start = bytes.readUInt32LE(end + 16)
  if (!count || count > 2001 || bytes.readUInt16LE(end + 8) !== count || start + size !== end) throw new BackupFailure('backup-invalid')
  let offset = start; let total = 0; const names = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50 || bytes.readUInt16LE(offset + 8) & 1) throw new BackupFailure('backup-invalid')
    const method = bytes.readUInt16LE(offset + 10); const expanded = bytes.readUInt32LE(offset + 24); const length = bytes.readUInt16LE(offset + 28)
    const next = offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
    if (next > end || ![0, 8].includes(method) || expanded > 128 * 1024 * 1024 || (bytes.readUInt32LE(offset + 38) >>> 16 & 0xf000) === 0xa000) throw new BackupFailure('backup-invalid')
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8')
    if (names.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..') || name.includes(':')) throw new BackupFailure('backup-invalid')
    names.add(name); total += expanded; if (total > MAX_UNPACKED_BYTES) throw new BackupFailure('file-too-large'); offset = next
  }
  if (offset !== end || !names.has('manifest.json')) throw new BackupFailure('backup-invalid')
  return names
}
export async function exportPrivateSave(options: { root: string; store: SessionStore; clock: Clock; source: 'real' | 'fake'; fileFilteringEnabled: boolean; credentials?: readonly string[]; onboarding?: OnboardingView }) {
  const { root, store, clock } = options; const archiveId = randomUUID(); const stage = directory(root, join(root, '.backup-staging', archiveId))
  const owner = { userId: store.scope.userId, characterId: store.scope.characterId }; const key = ownerKey(owner)
  const files = new Map<string, Buffer>(); const allRecords = store.history?.() ?? store.records()
  validateDeskChanges(allRecords)
  const folder = journalLocation(root, owner, clock).folder
  const activeDayKey = store.dayKey?.() ?? journalLocation(root, owner, clock).dayKey
  for (const name of readdirSync(folder).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name <= activeDayKey + '.jsonl').sort()) {
    const path = regular(root, join(folder, name), 128 * 1024 * 1024); const bytes = readFileSync(path); parseJournalContent(bytes.toString('utf8'), owner); files.set('journals/' + key + '/' + name, bytes)
  }
  const artifacts = allRecords.flatMap((row) => row.type === 'campus/exported' ? row.artifacts : row.type === 'document/completed' ? [row.artifact] : [])
  for (const row of allRecords) if (row.type === 'asset/stored') {
    const path = assetPath(row.asset); const bytes = readFileSync(regular(root, join(root, path), 32 * 1024 * 1024))
    if (bytes.length !== row.asset.byteLength || sha256(bytes) !== row.asset.sha256) throw new BackupFailure('backup-invalid'); files.set(path, bytes)
  }
  for (const artifact of artifacts) {
    if (!validPath(artifact.relativePath, key)) throw new BackupFailure('backup-invalid')
    const bytes = readFileSync(regular(root, join(root, artifact.relativePath), 32 * 1024 * 1024))
    if (sha256(bytes) !== artifact.sha256) throw new BackupFailure('backup-invalid'); files.set(artifact.relativePath, bytes)
  }
  for (const name of DATABASES) {
    const path = join(root, name); if (!existsSync(path)) continue
    regular(root, path, 128 * 1024 * 1024); const destination = join(stage, name)
    const db = new Database(path, { readonly: true, fileMustExist: true })
    try { await db.backup(destination) } finally { db.close() }
    checkDatabase(destination, name, owner, true); files.set(name, readFileSync(destination))
  }
  let total = 0
  for (const bytes of files.values()) { total += bytes.length; if (total > MAX_UNPACKED_BYTES) throw new BackupFailure('file-too-large'); noCredentials(bytes, options.credentials ?? []) }
  const manifest = manifestSchema.parse({ formatVersion: 1, kind: 'lca-private-save', archiveId, savedAtMs: clock.nowMs(), owner, source: options.source,
    activeDayKey, activeSessionId: store.scope.sessionId,
    pomodoro: (() => { const view = store.projection().pomodoro; if (view.status === 'running' && view.endsAtMs !== null) view.remainingMs = Math.max(0, view.endsAtMs - clock.nowMs()); return view })(),
    pomodoroPause: store.projection().pomodoroPause, fileFilteringEnabled: options.fileFilteringEnabled, onboarding: options.onboarding ?? store.projection().onboarding,
    counts: { pageCount: [...files.keys()].filter((path) => path.startsWith('journals/')).length, messageCount: allRecords.filter((row) => row.type === 'user/message' || row.type === 'assistant/message' && row.text).length,
      memoryCount: projectMemory(allRecords).items.length, deliveryCount: new Set(artifacts.map((artifact) => artifact.view.id)).size },
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
  })
  const zip = new JSZip(); zip.file('manifest.json', JSON.stringify(manifest), { createFolders: false })
  for (const [path, bytes] of files) zip.file(path, bytes, { createFolders: false })
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new BackupFailure('file-too-large')
  return { manifest, bytes }
}
export async function validatePrivateSave(bytes: Buffer, owner: SaveManifest['owner'], source: 'real' | 'fake') {
  try {
    const names = inspectZip(bytes); const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false })
    if (names.size !== Object.keys(zip.files).length) throw new BackupFailure('backup-invalid')
    const manifestBytes = await zip.file('manifest.json')!.async('nodebuffer'); if (manifestBytes.length > 1024 * 1024) throw new BackupFailure('backup-invalid')
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')))
    if (manifest.owner.userId !== owner.userId || manifest.owner.characterId !== owner.characterId || manifest.source !== source) throw new BackupFailure('backup-scope-mismatch')
    const key = ownerKey(owner); const paths = new Set<string>(); const files = new Map<string, Buffer>()
    for (const file of manifest.files) {
      if (paths.has(file.path) || !validPath(file.path, key) || !names.has(file.path)) throw new BackupFailure('backup-invalid'); paths.add(file.path)
      const entry = zip.file(file.path); if (!entry || entry.unsafeOriginalName !== file.path) throw new BackupFailure('backup-invalid')
      const data = await entry.async('nodebuffer'); if (data.length !== file.bytes || sha256(data) !== file.sha256) throw new BackupFailure('backup-invalid'); files.set(file.path, data)
    }
    if (names.size !== paths.size + 1) throw new BackupFailure('backup-invalid')
    if (DATABASES.some((name) => !files.has(name))) throw new BackupFailure('backup-invalid')
    const records = [...files].filter(([path]) => path.startsWith('journals/')).sort(([a], [b]) => a.localeCompare(b)).flatMap(([, data]) => parseJournalContent(data.toString('utf8'), owner))
    validateDeskChanges(records)
    const active = files.get('journals/' + key + '/' + manifest.activeDayKey + '.jsonl'); if (!active) throw new BackupFailure('backup-invalid')
    const projected = projectJournal(parseJournalContent(active.toString('utf8'), owner)); if (projected.scope.sessionId !== manifest.activeSessionId) throw new BackupFailure('backup-invalid')
    if (manifest.counts.pageCount !== [...files.keys()].filter((path) => path.startsWith('journals/')).length || manifest.counts.messageCount !== records.filter((row) => row.type === 'user/message' || row.type === 'assistant/message' && row.text).length || manifest.counts.memoryCount !== projectMemory(records).items.length) throw new BackupFailure('backup-invalid')
    const artifacts = records.flatMap((row) => row.type === 'campus/exported' ? row.artifacts : row.type === 'document/completed' ? [row.artifact] : [])
    if (manifest.counts.deliveryCount !== new Set(artifacts.map((artifact) => artifact.view.id)).size) throw new BackupFailure('backup-invalid')
    for (const artifact of artifacts) if (sha256(files.get(artifact.relativePath) ?? Buffer.alloc(0)) !== artifact.sha256) throw new BackupFailure('backup-invalid')
    for (const row of records) if (row.type === 'asset/stored') { const bytes = files.get(assetPath(row.asset)); if (!bytes || bytes.length !== row.asset.byteLength || sha256(bytes) !== row.asset.sha256) throw new BackupFailure('backup-invalid'); if (row.asset.format === 'glb') validateGlb(bytes) }
    return { manifest, files }
  } catch (cause) { if (cause instanceof BackupFailure) throw cause; throw new BackupFailure('backup-invalid') }
}
export async function stagePrivateSave(root: string, bytes: Buffer, owner: SaveManifest['owner'], source: 'real' | 'fake') {
  const checked = await validatePrivateSave(bytes, owner, source); const restoreId = randomUUID(); const stage = directory(root, join(root, '.backup-staging', restoreId))
  const payload = directory(root, join(stage, 'payload'))
  for (const [path, data] of checked.files) writeFileSync(privateWriteParent(root, join(payload, path)), data, { flag: 'wx', mode: 0o600 })
  for (const name of DATABASES) if (existsSync(join(payload, name))) checkDatabase(join(payload, name), name, owner)
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(checked.manifest), { flag: 'wx', mode: 0o600 })
  return { restoreId, stage, manifest: checked.manifest }
}
export function readArchiveFile(file: string) {
  const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_ARCHIVE_BYTES) throw new BackupFailure('backup-invalid')
  return readFileSync(file)
}

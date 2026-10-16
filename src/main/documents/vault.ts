import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DocumentFormat } from '../../shared'
import { MAX_FILE_BYTES, DocumentFailure } from './reader'

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
export interface DocumentVault { put(bytes: Uint8Array, format: DocumentFormat): string; read(ref: string): { bytes: Uint8Array; format: DocumentFormat }; close(): void }
export function openDocumentVault(root: string, owner: { userId: string; characterId: string }): DocumentVault {
  const db = new Database(join(root, 'documents.sqlite')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL')
  db.exec('CREATE TABLE IF NOT EXISTS private_documents (owner TEXT NOT NULL, ref TEXT NOT NULL, hash TEXT NOT NULL, format TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(owner,ref))')
  const scope = hash(JSON.stringify([owner.userId, owner.characterId]))
  return {
    put: (bytes, format) => {
      if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new DocumentFailure('file-too-large')
      const digest = hash(bytes); const ref = 'f:' + hash(scope + format + digest)
      db.prepare('INSERT OR IGNORE INTO private_documents VALUES (?,?,?,?,?)').run(scope, ref, digest, format, bytes)
      return ref
    },
    read: (ref) => {
      if (!/^f:[a-f0-9]{64}$/.test(ref)) throw new DocumentFailure('file-unreadable')
      const row = db.prepare('SELECT hash,format,bytes FROM private_documents WHERE owner=? AND ref=?').get(scope, ref) as { hash: string; format: DocumentFormat; bytes: Buffer } | undefined
      if (!row || !['pdf', 'text', 'markdown'].includes(row.format) || row.bytes.length > MAX_FILE_BYTES || hash(row.bytes) !== row.hash || 'f:' + hash(scope + row.format + row.hash) !== ref) throw new DocumentFailure('file-unreadable')
      return { bytes: new Uint8Array(row.bytes), format: row.format }
    }, close: () => db.close(),
  }
}

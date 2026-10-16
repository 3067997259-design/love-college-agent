import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { artifactSchema, type CampusArtifact } from '../campus/schema'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export interface ArtifactSpec { candidateId: string; revision: number; format: 'ics' | 'md'; displayName: string; source: 'real' | 'fake'; createdAtMs: number; content: string }
export function createArtifactStore(dataDir: string, owner: { userId: string; characterId: string }) {
  mkdirSync(dataDir, { recursive: true })
  const base = realpathSync(dataDir); const root = join(base, 'artifacts')
  if (!existsSync(root)) mkdirSync(root)
  const contained = (file: string) => { const rel = relative(root, resolve(file)); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') }
  const checkRoot = () => { if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('ARTIFACT_ROOT_INVALID') }
  const checkFile = (file: string) => {
    checkRoot()
    if (!contained(file) || dirname(file) !== root) throw new Error('ARTIFACT_PATH_INVALID')
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_000_000 || realpathSync(file) !== file) throw new Error('ARTIFACT_FILE_INVALID')
  }
  checkRoot()
  const describe = (spec: Omit<ArtifactSpec, 'content'>): CampusArtifact['view'] => {
    const id = hash(JSON.stringify([owner.userId, owner.characterId, spec.candidateId, spec.revision, spec.format]))
    return { id: 'd:' + id, artifactId: 'a:' + id, displayName: spec.displayName, kind: spec.format === 'ics' ? 'calendar' : 'markdown', status: 'ready', createdAtMs: spec.createdAtMs, sourceRefs: [spec.candidateId], source: spec.source }
  }
  const read = (artifact: CampusArtifact): string => {
    const parsed = artifactSchema.parse(artifact); const file = join(base, parsed.relativePath)
    checkFile(file)
    const content = readFileSync(file, 'utf8')
    if (hash(content) !== parsed.sha256) throw new Error('ARTIFACT_INTEGRITY_FAILED')
    return content
  }
  return { describe, read,
    write: (spec: ArtifactSpec): CampusArtifact => {
      const view = describe(spec); const id = view.artifactId.slice(2)
      const artifact = artifactSchema.parse({ view, relativePath: 'artifacts/' + id + '.' + spec.format, sha256: hash(spec.content) })
      const file = join(base, artifact.relativePath)
      checkRoot(); if (Buffer.byteLength(spec.content) > 1_000_000) throw new Error('ARTIFACT_TOO_LARGE')
      if (existsSync(file)) { read(artifact); return artifact }
      const temporary = join(root, '.' + randomUUID() + '.tmp')
      let fd: number | undefined
      try {
        checkRoot(); fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, spec.content, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
        // Hard-link creation is atomic and refuses an existing destination; never overwrite a conflicting file.
        checkRoot(); linkSync(temporary, file)
      } catch {
        if (existsSync(file)) { /* Verify an identical previous attempt after removing our temporary link. */ }
        else throw new Error('ARTIFACT_WRITE_FAILED')
      } finally {
        if (fd !== undefined) closeSync(fd)
        checkRoot(); if (contained(temporary) && existsSync(temporary)) unlinkSync(temporary)
      }
      read(artifact); return artifact
    },
  }
}
export type ArtifactStore = ReturnType<typeof createArtifactStore>

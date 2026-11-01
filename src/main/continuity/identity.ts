import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { ContinuityOwner } from '../../shared/continuity'

type Owner = Pick<ContinuityOwner, 'userId' | 'characterId'>
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const continuityIdentityName = 'continuity.json'
export const continuityIdentitySchema = z.strictObject({ version: z.literal(1), dataRootId: z.string().regex(/^[a-f0-9]{64}$/),
  mirrorEpochs: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.string().uuid()),
})
const ownerKey = (owner: Owner) => digest(JSON.stringify([owner.userId, owner.characterId]))

/** First installation adopts the pre-upgrade work ledger identity. Subsequent
 * folder moves keep that identity; it is no longer recomputed from the path. */
export function ensureContinuityIdentity(root: string, owner: Owner) {
  const path = join(root, continuityIdentityName)
  let state = { version: 1 as const, dataRootId: digest(root), mirrorEpochs: {} as Record<string, string> }
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256_000 || realpathSync(path) !== resolve(path)) throw new Error('CONTINUITY_IDENTITY_INVALID')
    state = continuityIdentitySchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }
  const key = ownerKey(owner)
  if (!state.mirrorEpochs[key]) {
    state.mirrorEpochs[key] = randomUUID()
    mkdirSync(root, { recursive: true })
    if (realpathSync(root) !== resolve(root) || lstatSync(root).isSymbolicLink()) throw new Error('CONTINUITY_IDENTITY_INVALID')
    const temporary = `${path}.${randomUUID()}.tmp`; const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
  }
  return { owner: { ...owner, dataRootId: state.dataRootId }, mirrorEpoch: state.mirrorEpochs[key] }
}

/** Prepared bytes join the same restore transaction as journals and databases.
 * A private archive cannot replace the receiving installation's identity. */
export function restoredContinuityIdentity(root: string, owner: Owner): Buffer {
  ensureContinuityIdentity(root, owner)
  const state = continuityIdentitySchema.parse(JSON.parse(readFileSync(join(root, continuityIdentityName), 'utf8')))
  state.mirrorEpochs[ownerKey(owner)] = randomUUID()
  return Buffer.from(JSON.stringify(state))
}

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface RoomLayout {
  /** Absolute room root. `书桌` and the other projection folders are its children. */
  root: string
  /** True for developer/booth/LCA_DATA_DIR profiles, where the data root already isolates the profile. */
  privateProfile: boolean
  /** Directory name under the shared base; absent for a private profile. */
  folder?: string
  /** Stable identity of the profile the root was derived from. */
  profileKey: string
}

/**
 * Room roots live outside the data root in normal mode, so the data root itself has to be part of the
 * directory name: without it every normal profile that shares an active character resolved to one folder
 * and overwrote the other profile's desk and projections (issue #8). Private profiles already sit under
 * their own data root and keep the historical name, so existing developer and test data stays reachable.
 */
export function resolveRoomLayout(options: { dataDir: string; sharedBase: string; ownerKey: string; privateProfile: boolean }): RoomLayout {
  const profileKey = createHash('sha256').update(profileIdentity(options.dataDir)).digest('hex').slice(0, 8)
  const ownerKey = options.ownerKey.toLowerCase()
  if (options.privateProfile) return { root: join(options.dataDir, 'rooms', ownerKey), privateProfile: true, profileKey }
  // Windows paths are case-insensitive, so two profiles differing only in case must not create two rooms.
  const folder = ownerKey.slice(0, 12) + '-' + profileKey
  return { root: join(options.sharedBase, '桃子的房间', folder), privateProfile: false, folder, profileKey }
}

/** Normalised data root: on Windows a differently spelled path must not become a second profile. */
function profileIdentity(dataDir: string) {
  const absolute = resolve(dataDir)
  if (!existsSync(absolute)) return absolute.toLowerCase()
  try { return realpathSync.native(absolute).toLowerCase() } catch { return absolute.toLowerCase() }
}

export interface StoredRoomLayout { pathVersion: 2; root: string; folder?: string }

/**
 * A recorded layout wins over the derived one, because the folder name is a formula that can change
 * again; a record that no longer belongs to this profile (or to this profile class) is ignored, so a
 * restored or re-pointed data root can never adopt another profile's room.
 */
export function resolveRoomRoot(options: { stored?: StoredRoomLayout; resolved: RoomLayout; persist?: (layout: RoomLayout) => void }): RoomLayout {
  const { resolved } = options
  const stored = options.stored
  const reusable = stored?.pathVersion === 2 && typeof stored.root === 'string' && isAbsolute(stored.root) && resolved.privateProfile === !stored.folder &&
    (resolved.privateProfile ? normalized(stored.root) === normalized(resolved.root) : stored.root.includes(resolved.folder ?? '\u0000'))
  if (reusable) { const adopted = { ...resolved, root: stored!.root }; options.persist?.(adopted); return adopted }
  options.persist?.(resolved)
  return resolved
}
const isAbsolute = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')
const normalized = (path: string) => path.replace(/[\\/]+$/, '').toLowerCase()

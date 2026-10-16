import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRoomLayout, resolveRoomRoot } from '../../src/main/room/paths'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function root(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => { if (!resolve(path).startsWith(join(resolve(tmpdir()), prefix))) throw new Error('Unsafe cleanup'); rmSync(path, { recursive: true, force: true }) })
  return path
}
const ownerKey = 'a'.repeat(64)

describe('room layout identity (issue #8)', () => {
  it('gives different normal profiles different room roots', () => {
    const shared = root('lca-room-shared-'); const first = root('lca-room-a-'); const second = root('lca-room-b-')
    const a = resolveRoomLayout({ dataDir: first, sharedBase: shared, ownerKey, privateProfile: false })
    const b = resolveRoomLayout({ dataDir: second, sharedBase: shared, ownerKey, privateProfile: false })
    expect(a.root).not.toBe(b.root)
    expect(a.folder).not.toBe(b.folder)
    expect(a.root.startsWith(join(shared, '桃子的房间'))).toBe(true)
    expect(a.folder).toBe('a'.repeat(12) + '-' + a.profileKey)
    expect(a.profileKey).toMatch(/^[a-f0-9]{8}$/)
  })
  it('keeps one profile on one root across restarts, including a differently spelled path', () => {
    const shared = root('lca-room-shared-'); const dir = join(root('lca-room-stable-'), 'profile')
    mkdirSync(dir, { recursive: true })
    const first = resolveRoomLayout({ dataDir: dir, sharedBase: shared, ownerKey, privateProfile: false })
    const again = resolveRoomLayout({ dataDir: dir, sharedBase: shared, ownerKey, privateProfile: false })
    const spelled = resolveRoomLayout({ dataDir: dir.toUpperCase(), sharedBase: shared, ownerKey, privateProfile: false })
    expect(again.root).toBe(first.root)
    expect(spelled.root).toBe(first.root)
  })
  it('keeps private profiles under their own data root with the historical folder name', () => {
    const shared = root('lca-room-shared-'); const dataDir = root('lca-room-dev-')
    const layout = resolveRoomLayout({ dataDir, sharedBase: shared, ownerKey, privateProfile: true })
    expect(layout.root).toBe(join(dataDir, 'rooms', ownerKey))
    expect(layout.privateProfile).toBe(true); expect(layout.folder).toBeUndefined()
  })
  it('separates profiles that only differ by the shared base as well', () => {
    const dataDir = root('lca-room-one-')
    const first = resolveRoomLayout({ dataDir, sharedBase: root('lca-room-s1-'), ownerKey, privateProfile: false })
    const second = resolveRoomLayout({ dataDir, sharedBase: root('lca-room-s2-'), ownerKey, privateProfile: false })
    expect(first.root).not.toBe(second.root)
  })
})

describe('recorded room layout', () => {
  it('reuses a recorded root instead of re-deriving the folder name', () => {
    const shared = root('lca-room-shared-'); const dataDir = root('lca-room-stored-')
    const resolved = resolveRoomLayout({ dataDir, sharedBase: shared, ownerKey, privateProfile: false })
    const recorded = join(shared, '桃子的房间', ownerKey.slice(0, 12) + '-' + resolved.profileKey)
    const written: { root: string; folder?: string }[] = []
    const layout = resolveRoomRoot({ stored: { pathVersion: 2, root: recorded, folder: resolved.folder }, resolved, persist: (value) => written.push({ root: value.root, ...(value.folder ? { folder: value.folder } : {}) }) })
    // root 保持记录值（目录名公式再变也不会静默搬家），folder 校正回当前 profile 身份。
    expect(layout.root).toBe(recorded); expect(written).toEqual([{ root: recorded, folder: resolved.folder }])
  })
  it('persists the derived root once and ignores a record from another profile', () => {
    const shared = root('lca-room-shared-'); const dataDir = root('lca-room-stored-')
    const resolved = resolveRoomLayout({ dataDir, sharedBase: shared, ownerKey, privateProfile: false })
    const written: string[] = []
    expect(resolveRoomRoot({ resolved, persist: (layout) => written.push(layout.root) }).root).toBe(resolved.root)
    expect(written).toEqual([resolved.root])
    // 记录里的目录名属于另一个 profile（另一份 profileKey），必须忽略而不是采用。
    const foreign = resolveRoomRoot({ stored: { pathVersion: 2, root: join(shared, '桃子的房间', ownerKey.slice(0, 12) + '-deadbeef'), folder: ownerKey.slice(0, 12) + '-deadbeef' }, resolved })
    expect(foreign.root).toBe(resolved.root)
    // 相对路径与错误版本同样被忽略。
    expect(resolveRoomRoot({ stored: { pathVersion: 2, root: 'relative/room', folder: resolved.folder }, resolved }).root).toBe(resolved.root)
  })
})

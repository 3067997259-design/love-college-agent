import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { SessionStore } from '../store/session'

export const binaryAssetSchema = z.strictObject({ ref: z.string().regex(/^asset:[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  format: z.enum(['glb', 'png', 'jpg', 'webp', 'zip']), byteLength: z.number().int().positive().max(32 * 1024 * 1024) }).refine((asset) => asset.ref === 'asset:' + asset.sha256)
export type BinaryAsset = z.infer<typeof binaryAssetSchema>
export const assetPath = (asset: BinaryAsset) => 'artifacts/' + asset.sha256 + '.' + asset.format
export const assetUrl = (asset: BinaryAsset) => 'lca-media://asset/' + asset.sha256
export function createBinaryAssets(root: string, store: SessionStore) {
  const folder = join(resolve(root), 'artifacts'); mkdirSync(folder, { recursive: true })
  const check = () => { if (lstatSync(folder).isSymbolicLink() || realpathSync(folder) !== folder) throw new Error('ASSET_ROOT_INVALID') }
  const read = (asset: BinaryAsset) => {
    check(); const file = join(root, assetPath(binaryAssetSchema.parse(asset))); const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== asset.byteLength) throw new Error('ASSET_INVALID')
    const bytes = readFileSync(file); if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('ASSET_INVALID'); return bytes
  }
  return { read,
    has: (asset: BinaryAsset) => { try { check(); const stat = lstatSync(join(root, assetPath(binaryAssetSchema.parse(asset)))); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === asset.byteLength } catch { return false } },
    owned: (sha: string) => (store.history?.() ?? store.records()).flatMap((row) => row.type === 'asset/stored' && row.asset.sha256 === sha ? [row.asset] : []).at(-1),
    write: (bytes: Buffer, format: BinaryAsset['format']): BinaryAsset => {
      check(); const sha256 = createHash('sha256').update(bytes).digest('hex'); const asset = binaryAssetSchema.parse({ ref: 'asset:' + sha256, sha256, format, byteLength: bytes.length })
      const file = join(root, assetPath(asset)); if (existsSync(file)) { read(asset); return asset }
      const temporary = join(folder, '.' + randomUUID() + '.tmp'); const fd = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      try { check(); linkSync(temporary, file) } finally { unlinkSync(temporary) }
      read(asset); return asset
    },
  }
}
export type BinaryAssets = ReturnType<typeof createBinaryAssets>

export function validateGlb(bytes: Buffer) {
  if (bytes.length < 20 || bytes.length > 32 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB_INVALID')
  const size = bytes.readUInt32LE(12); if (size > bytes.length - 20) throw new Error('GLB_INVALID')
  const scene: unknown = JSON.parse(bytes.subarray(20, 20 + size).toString('utf8'))
  if (z.object({ asset: z.object({ version: z.literal('2.0') }) }).safeParse(scene).success === false) throw new Error('GLB_INVALID')
  if (scene && typeof scene === 'object' && 'extensionsUsed' in scene && Array.isArray(scene.extensionsUsed) && scene.extensionsUsed.some((name) => name === 'EXT_meshopt_compression' || name === 'KHR_draco_mesh_compression')) throw new Error('GLB_UNSUPPORTED_COMPRESSION')
  const visit = (value: unknown) => { if (!value || typeof value !== 'object') return; for (const [key, entry] of Object.entries(value)) { if (key === 'uri' && (typeof entry !== 'string' || !/^data:(?:image\/(?:png|jpeg)|application\/octet-stream);base64,[A-Za-z0-9+/=]+$/.test(entry))) throw new Error('GLB_EXTERNAL_RESOURCE'); visit(entry) } }
  visit(scene)
}

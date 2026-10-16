import JSZip from 'jszip'
import { expect, it } from 'vitest'
import { parseCharacterPackage, pngDimensions } from '../../src/main/characters/package'
import { packageScene } from '../../src/renderer/src/book/characterPackage'
import type { AppSnapshot } from '../../src/shared'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5YsAAAAASUVORK5CYII=', 'base64')
const manifest = { formatVersion: 1, kind: 'lca-character', name: '合成角色', persona: '合成人设，不执行任何代码。', images: { 'facing-user_calm': 'images/facing-user_calm.png' } }
async function pack(extra?: (zip: JSZip) => void, value: unknown = manifest) { const zip = new JSZip(); zip.file('manifest.json', JSON.stringify(value), { createFolders: false }); zip.file('images/facing-user_calm.png', png, { createFolders: false }); extra?.(zip); return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) }
it('imports only declared static PNG assets and strips unknown/private manifest fields', async () => {
  const parsed = await parseCharacterPackage(await pack(), (bytes) => bytes); expect(parsed.name).toBe('合成角色'); expect(parsed.images['facing-user_calm']).toEqual(png)
  for (const value of [{ ...manifest, userName: 'PRIVATE' }, { ...manifest, api_key: 'PRIVATE' }, { ...manifest, formatVersion: 2 }]) await expect(parseCharacterPackage(await pack(undefined, value), (bytes) => bytes)).rejects.toThrow()
  for (const name of ['main.js', '../escape.png', 'images/unknown.png', 'secrets/providers.json']) await expect(parseCharacterPackage(await pack((zip) => zip.file(name, 'payload', { createFolders: false })), (bytes) => bytes)).rejects.toThrow()
})
it('rejects forged expanded sizes before unbounded inflation and oversized image dimensions', async () => {
  const bytes = await pack(); const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bytes.writeUInt32LE(1, central + 24)
  await expect(parseCharacterPackage(bytes, (value) => value)).rejects.toThrow()
  const oversized = Buffer.from(png); oversized.writeUInt32BE(100000, 16); expect(() => pngDimensions(oversized)).toThrow()
})
it('falls back inside a character before the built-in scene and preserves away state', () => {
  const snapshot = { characterPack: { images: { 'facing-user_calm': 'owned-face', 'desk-writing_calm': 'owned-desk' } } } as unknown as AppSnapshot
  expect(packageScene(snapshot, 'desk-writing_night')).toBe('owned-desk'); expect(packageScene(snapshot, 'sleeping_dark')).toBe('owned-face'); expect(packageScene(snapshot, 'empty')).toBeUndefined()
})

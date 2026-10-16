import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { inflateRawSync } from 'node:zlib'
import { z } from 'zod'
import type { BinaryAsset } from '../storage/assets'
import { binaryAssetSchema } from '../storage/assets'
import { characterNameInput } from '../onboarding/schema'
const slot = z.string().regex(/^(?:empty|[a-z][a-z0-9-]{0,32}_[a-z][a-z0-9-]{0,24})$/)
export const characterManifest = z.strictObject({ formatVersion: z.literal(1), kind: z.literal('lca-character'), name: characterNameInput.refine((name) => !!name), persona: z.string().trim().max(4000).refine((text) => ![...text].some((char) => char.charCodeAt(0) === 0)), images: z.record(slot, z.string().regex(/^images\/[a-z][a-z0-9_-]{0,80}\.png$/)).refine((images) => Object.keys(images).length <= 24) })
export const definitionSchema = z.strictObject({ id: z.string().regex(/^character:[a-f0-9]{64}$/), name: characterNameInput, persona: z.string().max(4000), images: z.record(slot, binaryAssetSchema.refine((asset) => asset.format === 'png')) })
export type CharacterDefinition = z.infer<typeof definitionSchema>
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export const definitionId = (value: Omit<CharacterDefinition, 'id'>) => 'character:' + digest(JSON.stringify([value.name, value.persona, Object.entries(value.images).sort(([a], [b]) => a.localeCompare(b)).map(([slot, asset]) => [slot, asset.sha256])]))
function inspect(bytes: Buffer) {
  if (bytes.length < 22 || bytes.length > 32 * 1024 * 1024) throw new Error('CHARACTER_INVALID')
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) throw new Error('CHARACTER_INVALID')
  const count = bytes.readUInt16LE(end + 10); let offset = bytes.readUInt32LE(end + 16); const start = offset; let total = 0; const files = new Map<string, Buffer>()
  if (!count || count > 25 || start + bytes.readUInt32LE(end + 12) !== end) throw new Error('CHARACTER_INVALID')
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50 || bytes.readUInt16LE(offset + 8) & 1 || ![0, 8].includes(bytes.readUInt16LE(offset + 10))) throw new Error('CHARACTER_INVALID')
    const length = bytes.readUInt16LE(offset + 28); const next = offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32); const expanded = bytes.readUInt32LE(offset + 24); const local = bytes.readUInt32LE(offset + 42)
    if (next > end || expanded > 8 * 1024 * 1024 || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) & 1 || (bytes.readUInt32LE(offset + 38) >>> 16 & 0xf000) === 0xa000) throw new Error('CHARACTER_INVALID')
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8'); const localName = bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).toString('utf8')
    if (name !== localName || files.has(name) || !/^(?:manifest\.json|images\/[a-z][a-z0-9_-]{0,80}\.png)$/.test(name)) throw new Error('CHARACTER_INVALID')
    const method = bytes.readUInt16LE(offset + 10); const compressed = bytes.readUInt32LE(offset + 20); const dataAt = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (dataAt + compressed > start || bytes.readUInt16LE(local + 8) !== method || expanded > (name === 'manifest.json' ? 16000 : 8 * 1024 * 1024)) throw new Error('CHARACTER_INVALID')
    const payload = bytes.subarray(dataAt, dataAt + compressed); const content = method === 0 ? Buffer.from(payload) : inflateRawSync(payload, { maxOutputLength: Math.max(1, expanded) })
    if (content.length !== expanded) throw new Error('CHARACTER_INVALID')
    let crc = 0xffffffff; for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1 }
    if ((~crc >>> 0) !== bytes.readUInt32LE(offset + 16)) throw new Error('CHARACTER_INVALID')
    files.set(name, content); total += expanded; if (total > 32 * 1024 * 1024) throw new Error('CHARACTER_INVALID'); offset = next
  }
  if (offset !== end || !files.has('manifest.json')) throw new Error('CHARACTER_INVALID'); return files
}
/** PNG header dimensions checked before decoding. Re-encoding strips original metadata and trailing payloads. */
export function pngDimensions(bytes: Buffer) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('CHARACTER_INVALID')
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20)
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000) throw new Error('CHARACTER_INVALID'); return { width, height }
}
export async function parseCharacterPackage(bytes: Buffer, normalizePng: (bytes: Buffer) => Buffer) {
  const files = inspect(bytes); const manifestText = files.get('manifest.json')!.toString('utf8')
  if (Buffer.byteLength(manifestText) > 16000) throw new Error('CHARACTER_INVALID'); const manifest = characterManifest.parse(JSON.parse(manifestText)); const allowed = new Set(['manifest.json', ...Object.values(manifest.images)])
  if (files.size !== allowed.size || [...files.keys()].some((name) => !allowed.has(name))) throw new Error('CHARACTER_INVALID')
  const images: Record<string, Buffer> = {}; let pixels = 0
  for (const [slot, path] of Object.entries(manifest.images)) { const source = files.get(path); if (!source) throw new Error('CHARACTER_INVALID'); const dimensions = pngDimensions(source); pixels += dimensions.width * dimensions.height; if (pixels > 16_000_000) throw new Error('CHARACTER_INVALID'); const normalized = normalizePng(source); pngDimensions(normalized); if (normalized.length > 8 * 1024 * 1024) throw new Error('CHARACTER_INVALID'); images[slot] = normalized }
  return { name: manifest.name, persona: manifest.persona, images }
}
export async function exportCharacterPackage(definition: { name: string; persona: string; images: Record<string, BinaryAsset> }, read: (asset: BinaryAsset) => Buffer) {
  const zip = new JSZip(); const images: Record<string, string> = {}
  for (const [slot, asset] of Object.entries(definition.images)) { const path = 'images/' + slot + '.png'; images[slot] = path; zip.file(path, read(asset), { createFolders: false }) }
  zip.file('manifest.json', JSON.stringify(characterManifest.parse({ formatVersion: 1, kind: 'lca-character', name: definition.name, persona: definition.persona, images })), { createFolders: false })
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

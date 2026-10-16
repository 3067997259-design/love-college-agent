import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { exportCharacterPackage } from './package'
import type { BinaryAsset } from '../storage/assets'
const slots = ['desk-computer_calm', 'desk-writing_calm', 'desk-writing_night', 'empty', 'facing-user_calm', 'facing-user_smile', 'facing-user_worried', 'sleeping_calm', 'sleeping_dark', 'sleeping_nightlight']
export async function exportBuiltinCharacter(rendererFolder: string) {
  const folder = join(rendererFolder, 'assets'); const files = readdirSync(folder); const data = new Map<string, Buffer>(); const images: Record<string, BinaryAsset> = {}
  for (const slot of slots) {
    const filename = files.find((file) => file.startsWith(slot + '-') && file.endsWith('.png')); if (!filename) continue
    const bytes = readFileSync(join(folder, filename)); const sha256 = createHash('sha256').update(bytes).digest('hex'); const asset = { ref: 'asset:' + sha256, sha256, format: 'png' as const, byteLength: bytes.length }; images[slot] = asset; data.set(sha256, bytes)
  }
  return exportCharacterPackage({ name: '桃子', persona: '', images }, (asset) => { const bytes = data.get(asset.sha256); if (!bytes) throw new Error('CHARACTER_INVALID'); return bytes })
}

import type { AppSnapshot } from '../../../shared'
export function packageScene(snapshot: AppSnapshot, key: string) {
  const images = snapshot.characterPack?.images; if (!images) return undefined
  return images[key] ?? (key === 'empty' ? undefined : images[key.split('_')[0] + '_calm'] ?? images['facing-user_calm'])
}

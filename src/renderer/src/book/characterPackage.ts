import type { AppSnapshot } from '../../../shared'
import type { CharacterArt } from './characterArt'

/** 精确槽位优先；缺失时才回退 baseKey／同姿势 calm／正面 calm。回退到白天图时必须保留 ambient 调色。 */
export interface ResolvedPackageScene { src: string; lighting: CharacterArt['lighting'] }

export function resolvePackageScene(snapshot: AppSnapshot, art: CharacterArt): ResolvedPackageScene | undefined {
  const images = snapshot.characterPack?.images; if (!images) return undefined
  if (images[art.key]) return { src: images[art.key], lighting: art.lighting }
  // Away/empty must stay empty when the pack has no such slot: fall back to the built-in away scene.
  if (art.key === 'empty' || art.key === 'empty__night') return undefined
  const fallbackKey = art.baseKey ?? art.key.split('_')[0] + '_calm'
  const fallback = images[fallbackKey] ?? images['facing-user_calm']
  if (!fallback) return undefined
  // A day/base fallback never carries the baked night/dark marker; it must receive the room tint.
  return { src: fallback, lighting: 'ambient' }
}

/** Legacy helper kept for callers that only need the image URL. New code should use resolvePackageScene for lighting. */
export function packageScene(snapshot: AppSnapshot, key: string): string | undefined {
  const images = snapshot.characterPack?.images; if (!images) return undefined
  return images[key] ?? (key === 'empty' ? undefined : images[key.split('_')[0] + '_calm'] ?? images['facing-user_calm'])
}

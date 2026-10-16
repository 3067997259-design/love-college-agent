import type { AppSnapshot } from '../../../shared'

export interface CharacterArt {
  key: string
  lighting: 'ambient' | 'baked-night' | 'baked-dark'
}

/** 光照不改变生活事实：熄灯表示暂停，不能把清醒的她画成睡着。 */
export function resolveCharacterArt(companion: AppSnapshot['companion']): CharacterArt {
  const { locationId, pose, expression, daypart, lightsOut } = companion
  if (locationId !== 'room') return { key: 'empty', lighting: 'ambient' }
  if (pose === 'sleeping') {
    if (lightsOut) return { key: 'sleeping_dark', lighting: 'baked-dark' }
    if (daypart === 'night') return { key: 'sleeping_nightlight', lighting: 'baked-night' }
    return { key: 'sleeping_calm', lighting: 'ambient' }
  }
  if (pose === 'desk-writing') {
    return daypart === 'night' && !lightsOut
      ? { key: 'desk-writing_night', lighting: 'baked-night' }
      : { key: 'desk-writing_calm', lighting: 'ambient' }
  }
  if (pose === 'facing-user') {
    const face = expression === 'smile' || expression === 'worried' ? expression : 'calm'
    return { key: `facing-user_${face}`, lighting: 'ambient' }
  }
  return { key: 'desk-computer_calm', lighting: 'ambient' }
}

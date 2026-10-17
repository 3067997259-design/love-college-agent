import type { AppSnapshot } from '../../../shared'

export interface CharacterArt {
  key: string
  lighting: 'ambient' | 'baked-night' | 'baked-dark'
  /** 整帧变体对应的 approved 基础名；自定义角色包用基础姿势回退（不替换包内素材） */
  baseKey?: string
}

/** 光照不改变生活事实：熄灯表示暂停，不能把清醒的她画成睡着。 */
export function resolveCharacterArt(companion: AppSnapshot['companion']): CharacterArt {
  const { locationId, pose, expression, daypart, lightsOut } = companion
  // 夜里且没有明确熄灯：用画内重光图；熄灯仍然只是加暗色，不把清醒画成睡着
  const night = daypart === 'night' && !lightsOut
  if (locationId !== 'room') {
    // 外景由 life/awayArt 处理；这里只是旧地点／无外景素材时的空房间回退
    return night
      ? { key: 'empty__night', lighting: 'baked-night', baseKey: 'empty' }
      : { key: 'empty', lighting: 'ambient', baseKey: 'empty' }
  }
  if (pose === 'sleeping') {
    if (lightsOut) return { key: 'sleeping_dark', lighting: 'baked-dark' }
    if (daypart === 'night') return { key: 'sleeping_nightlight', lighting: 'baked-night' }
    return { key: 'sleeping_calm', lighting: 'ambient' }
  }
  if (pose === 'desk-writing') {
    return night
      ? { key: 'desk-writing_night', lighting: 'baked-night', baseKey: 'desk-writing_calm' }
      : { key: 'desk-writing_calm', lighting: 'ambient' }
  }
  if (pose === 'facing-user') {
    // 思考表情目前只有白天整帧；夜里没有 think 夜景，沿用时段调色回退
    if (expression === 'think') return { key: 'facing-user_think', lighting: 'ambient', baseKey: 'facing-user_calm' }
    const face = expression === 'smile' || expression === 'worried' ? expression : 'calm'
    return night
      ? { key: `facing-user_${face}__night`, lighting: 'baked-night', baseKey: `facing-user_${face}` }
      : { key: `facing-user_${face}`, lighting: 'ambient' }
  }
  return night
    ? { key: 'desk-computer_calm__night', lighting: 'baked-night', baseKey: 'desk-computer_calm' }
    : { key: 'desk-computer_calm', lighting: 'ambient' }
}

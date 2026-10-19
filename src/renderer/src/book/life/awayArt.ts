import type { AppSnapshot } from '../../../../shared'

/**
 * 外出时左页的那一页：她在外面，穿出门那套衣服（体验设计 §3“外出”）。
 * 2026-10-17 晚接入：复用视频冻结包（art/film-frozen/2026-10-17-v1）里已经画好的外景，
 * 不再只显示空房间＋纸条。素材映射与来源见同目录 away/manifest.json 和
 * 当前素材契约见 docs/art-spec.md；原始接入记录见冻结归档。
 *
 * 边界：
 * - 秋千夜景有画内夜光的整图，用 baked-night，不再叠加调色；
 * - 海岸夜景由差分批次补了整帧重光（2026-10-17 晚），用 baked-night；不再靠白天画面调色。
 * - 地点、时段都只读主进程快照，不从时间或天色自己推。
 */

export type AwayLighting = 'ambient' | 'baked-night'

export interface AwayArt {
  /** away/ 下的运行素材名，也写进 data-art 供测试与历史照片核对 */
  key: string
  place: 'coast' | 'swing'
  /** 迷你窗 SVG 的取景对齐：风景不是方的，裁切不能把她裁掉 */
  align: 'xMidYMid' | 'xMaxYMid' | 'xMinYMid'
  /** 左页 600×600 取景焦点（CSS object-position） */
  focus: string
  lighting: AwayLighting
}

const ART: Record<string, AwayArt> = {
  'coast-day': {
    key: 'coast-day', place: 'coast', align: 'xMidYMid', focus: '48% 58%', lighting: 'ambient',
  },
  'coast-evening': {
    key: 'coast-evening', place: 'coast', align: 'xMidYMid', focus: '44% 56%', lighting: 'ambient',
  },
  'coast-night': {
    key: 'coast-night', place: 'coast', align: 'xMidYMid', focus: '48% 58%', lighting: 'baked-night',
  },
  'swing-day': {
    key: 'swing-day', place: 'swing', align: 'xMaxYMid', focus: '72% 60%', lighting: 'ambient',
  },
  'swing-evening': {
    key: 'swing-evening', place: 'swing', align: 'xMidYMid', focus: '55% 52%', lighting: 'ambient',
  },
  'swing-night': {
    key: 'swing-night', place: 'swing', align: 'xMidYMid', focus: '58% 45%', lighting: 'baked-night',
  },
}

/** 地点只认主进程给的 coast／swing；旧记录或自定义地点回退到空房间（返回 null）。 */
export function resolveAwayArt(
  companion: Pick<AppSnapshot['companion'], 'locationId' | 'daypart'>,
): AwayArt | null {
  const place = companion.locationId
  if (place !== 'coast' && place !== 'swing') return null
  if (place === 'coast') {
    if (companion.daypart === 'evening') return ART['coast-evening']
    if (companion.daypart === 'night') return ART['coast-night']
    return ART['coast-day']
  }
  if (companion.daypart === 'night') return ART['swing-night']
  if (companion.daypart === 'evening') return ART['swing-evening']
  return ART['swing-day']
}

/** 外出素材：海岸白天/傍晚/夜里、秋千白天/傍晚/夜里，共六张。 */
export const AWAY_ART_KEYS = Object.keys(ART) as (keyof typeof ART)[]


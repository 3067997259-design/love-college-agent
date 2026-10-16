import { DEFAULT_EXPRESSION } from '../../../shared'

/**
 * 她的图层。两个镜头（2026-10-16 用户定）：
 * - close：固定近景，她在的时候用。她本人胸部以上，每个姿势一张透明底，头的位置相同（图生图派生）。
 * - wide：远景房间，她不在（出门）或睡着时用。书桌组透明底，对齐到同一个桌面位置。
 * 文件名“姿势_表情”（体验设计 §4、§8），缺什么回退什么：姿势_表情 → 姿势_calm → 姿势 → 占位。
 * 同名加 _line 的是这张图的铅笔线稿（Director Tools 抽取，和彩色版对齐）。
 */
export type Shot = 'close' | 'wide'

const files = import.meta.glob('../assets/character/taozi/*/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const byKey = new Map(Object.entries(files).map(([path, url]) => {
  const [shot, file] = path.split('/').slice(-2)
  return [`${shot}/${file.replace(/\.webp$/, '')}`, url]
}))

export function resolveCharacterArt(shot: Shot, pose: string, expression: string): string | null {
  const key = [`${pose}_${expression}`, `${pose}_${DEFAULT_EXPRESSION}`, pose].find((name) => byKey.has(`${shot}/${name}`))
  return key ? `${shot}/${key}` : null
}

export function Character({ shot, pose, expression, variant = 'color' }: {
  shot: Shot
  pose: string
  expression: string
  variant?: 'color' | 'line'
}) {
  const key = resolveCharacterArt(shot, pose, expression)
  // 线稿只在外圈露出来；表情差分没有单独的线稿时，沿用同姿势平静那张的
  const src = !key ? undefined
    : variant === 'color' ? byKey.get(key)
      : byKey.get(`${key}_line`) ?? byKey.get(`${shot}/${pose}_${DEFAULT_EXPRESSION}_line`)
  return (
    <div className={`character character-${variant}`} data-shot={shot} data-pose={pose} data-expression={expression}>
      {src
        ? <img className="character-art" src={src} alt="" draggable={false} />
        : variant === 'color' && <div className="character-missing">{POSE_LABEL[pose] ?? pose}<small>（立绘待画）</small></div>}
    </div>
  )
}

const POSE_LABEL: Record<string, string> = {
  'desk-computer': '坐在电脑前',
  'desk-writing': '低头写字',
  'facing-user': '转过来面向你',
  sleeping: '睡着了',
  empty: '出门了',
}

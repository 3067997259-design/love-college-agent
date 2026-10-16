import { DEFAULT_EXPRESSION } from '../../../shared'

/**
 * 她的图层。两个镜头（2026-10-16 用户定）：
 * - close：固定近景，她在的时候用。每个姿势是一整张场景图（她、书桌、窗一起画，透视才对），
 *   全部从同一张底图派生：除了她的头（写字那张还有桌面），每张逐像素相同，换姿势就是她转头。
 *   脸是设定图那批表情的原图放大两倍贴进去再融合的（美术规范 §6.8），小尺寸下不会变成通用脸。
 * - wide：远景房间，她不在（出门）或睡着时用。书桌组透明底，对齐到同一个桌面位置。
 * 文件名“姿势_表情”（体验设计 §4、§8），缺什么回退什么：姿势_表情 → 姿势_calm → 姿势 → 这个镜头的默认姿势 → 占位。
 * 同名加 _line 的是这张图的铅笔线稿（Director Tools 抽取，和彩色版对齐）；近景只有桌面不同才单独抽，其余共用默认姿势的。
 */
export type Shot = 'close' | 'wide'

/** 近景缺图时退回她在电脑前，房间不会空着 */
const SHOT_DEFAULT_POSE: Partial<Record<Shot, string>> = { close: 'desk-computer' }

const files = import.meta.glob('../assets/character/taozi/*/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const byKey = new Map(Object.entries(files).map(([path, url]) => {
  const [shot, file] = path.split('/').slice(-2)
  return [`${shot}/${file.replace(/\.webp$/, '')}`, url]
}))

export function resolveCharacterArt(shot: Shot, pose: string, expression: string): string | null {
  const fallback = SHOT_DEFAULT_POSE[shot]
  const key = [`${pose}_${expression}`, `${pose}_${DEFAULT_EXPRESSION}`, pose, fallback && `${fallback}_${DEFAULT_EXPRESSION}`]
    .find((name) => name && byKey.has(`${shot}/${name}`))
  return key ? `${shot}/${key}` : null
}

export function Character({ shot, pose, expression, variant = 'color' }: {
  shot: Shot
  pose: string
  expression: string
  variant?: 'color' | 'line'
}) {
  const key = resolveCharacterArt(shot, pose, expression)
  // 线稿只在外圈露出来；表情差分没有单独的线稿时，沿用同姿势平静那张的，再没有就用这个镜头默认姿势的
  const fallback = SHOT_DEFAULT_POSE[shot]
  const src = !key ? undefined
    : variant === 'color' ? byKey.get(key)
      : byKey.get(`${key}_line`) ?? byKey.get(`${shot}/${pose}_${DEFAULT_EXPRESSION}_line`)
        ?? (fallback ? byKey.get(`${shot}/${fallback}_${DEFAULT_EXPRESSION}_line`) : undefined)
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

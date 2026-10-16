import { DEFAULT_EXPRESSION } from '../../../shared'

/**
 * 书桌组：书桌、台灯、电脑和她，每个姿势一张透明底（2026-10-16 用户定：房间背景 + 书桌组分层）。
 * 按“姿势_表情”的文件名找素材（体验设计 §4、§8），缺什么回退什么：
 * 姿势_表情 → 姿势_calm → 姿势 → 占位轮廓。所有书桌组都对齐到同一个桌面位置（1216×1000 画布）。
 */
const files = import.meta.glob('../assets/character/taozi/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const byName = new Map(Object.entries(files).map(([path, url]) => [path.split('/').pop()!.replace(/\.webp$/, ''), url]))

export function resolveCharacterArt(pose: string, expression: string): string | null {
  return byName.get(`${pose}_${expression}`) ?? byName.get(`${pose}_${DEFAULT_EXPRESSION}`) ?? byName.get(pose) ?? null
}

export function Character({ pose, expression, variant = 'color' }: { pose: string; expression: string; variant?: 'color' | 'line' }) {
  const color = resolveCharacterArt(pose, expression)
  const src = color && variant === 'line' ? lineOf(color) : color
  return (
    <div className={`character character-${variant}`} data-pose={pose} data-expression={expression}>
      {src
        ? <img className="character-art" src={src} alt="" draggable={false} />
        : variant === 'color' && <div className="character-missing">{POSE_LABEL[pose] ?? pose}<small>（立绘待画）</small></div>}
    </div>
  )
}

/** 同名加 _line 的是这张图的铅笔线稿（Director Tools 抽取，已和彩色版对齐） */
const lineByUrl = new Map([...byName].flatMap(([name, url]) => {
  const line = byName.get(`${name}_line`)
  return line ? [[url, line] as const] : []
}))
function lineOf(colorUrl: string): string | null {
  return lineByUrl.get(colorUrl) ?? null
}

const POSE_LABEL: Record<string, string> = {
  'desk-computer': '坐在电脑前',
  'desk-writing': '低头写字',
  'facing-user': '转过来面向你',
  sleeping: '睡着了',
  empty: '出门了',
}

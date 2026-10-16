import { DEFAULT_EXPRESSION } from '../../../shared'

/**
 * 角色层：按“姿势_表情”的文件名找素材（体验设计 §4、§8），缺什么回退什么：
 * 姿势_表情 → 姿势_calm → 占位轮廓。现在的素材是设定图 v1 的临时裁切（白底，靠 multiply 叠在纸上）。
 */
const files = import.meta.glob('../assets/character/taozi/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const byName = new Map(Object.entries(files).map(([path, url]) => [path.split('/').pop()!.replace(/\.webp$/, ''), url]))

export function resolveCharacterArt(pose: string, expression: string): string | null {
  return byName.get(`${pose}_${expression}`) ?? byName.get(`${pose}_${DEFAULT_EXPRESSION}`) ?? null
}

export function Character({ pose, expression }: { pose: string; expression: string }) {
  const src = resolveCharacterArt(pose, expression)
  return (
    <div className="character" data-pose={pose} data-expression={expression}>
      {src
        ? <img className="character-art" src={src} alt="" draggable={false} />
        : <div className="character-missing">{POSE_LABEL[pose] ?? pose}<small>（立绘待画）</small></div>}
    </div>
  )
}

const POSE_LABEL: Record<string, string> = {
  'desk-computer': '坐在电脑前',
  'desk-writing': '低头写字',
  'facing-user': '转过来面向你',
  sleeping: '睡着了',
}

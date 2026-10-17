import type { CharacterArt } from './characterArt'

// 用户批准的整景精修图。旧线稿与新图不再对齐，不作为回退叠加。
const files = import.meta.glob('../assets/character/taozi/approved/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
// 外出页复用的视频冻结包素材（风景不是方的，按地点／时段选图，见 life/awayArt.ts）
const awayFiles = import.meta.glob('../assets/character/taozi/away/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

/** 整景图的地址；缺素材时返回 undefined，由调用方显示缺失提示 */
export function sceneSrc(key: string): string | undefined {
  return files[`../assets/character/taozi/approved/${key}.png`]
}

/** 外景页素材的地址；缺素材时回退空房间＋纸条（不显示缺失图） */
export function awaySceneSrc(key: string): string | undefined {
  return awayFiles[`../assets/character/taozi/away/${key}.png`]
}

export function Character({ art }: { art: CharacterArt }) {
  const src = sceneSrc(art.key)
  return (
    <div className="character character-color" data-art={art.key}>
      {src
        ? <img className="character-art" src={src} alt="" draggable={false} />
        : <div className="character-missing">（场景素材缺失）</div>}
    </div>
  )
}

import type { CharacterArt } from './characterArt'

// 用户批准的整景精修图。旧线稿与新图不再对齐，不作为回退叠加。
const files = import.meta.glob('../assets/character/taozi/approved/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

export function Character({ art }: { art: CharacterArt }) {
  const src = files[`../assets/character/taozi/approved/${art.key}.png`]
  return (
    <div className="character character-color" data-art={art.key}>
      {src
        ? <img className="character-art" src={src} alt="" draggable={false} />
        : <div className="character-missing">（场景素材缺失）</div>}
    </div>
  )
}

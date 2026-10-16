import { useEffect, useRef, useState } from 'react'
import type { AppSnapshot, LifeView } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { ObjectSketch } from './objects'
import { dayKeyLabel, fill } from './text'

/**
 * 她出门带回来的东西，摆在窗台上（技术方案 §3.14：桌面最多三件，其余收进抽屉）。
 * 精修整景里窗台左段在每个姿势下都空着（钟在上方、她从 53% 往右），三个位置按纹理坐标排。
 * 物件是房间里的东西：跟着房间进历史照片、跟着光线变暗；点开的小纸条是界面，拍照时不拍。
 */
const SPOTS = [{ x: 37.6, y: 54.7, tilt: -4 }, { x: 43, y: 54.7, tilt: 3 }, { x: 48.2, y: 54.7, tilt: -2 }] as const

export function SillItems({ snapshot, onOpenDiary }: { snapshot: AppSnapshot; onOpenDiary: (dayKey: string) => void }) {
  const items = (snapshot.life?.items ?? []).filter((item) => item.display === 'desk').slice(-SPOTS.length)
  const entering = useNewIds(snapshot.epoch, items.map((item) => item.id))
  const [openId, setOpenId] = useState<string | null>(null)
  const open = items.find((item) => item.id === openId)
  if (!items.length) return null
  return (
    <>
      {items.map((item, index) => {
        const spot = SPOTS[index]
        return (
          <button key={item.id} type="button" className="sill-item" data-kind={item.kind} data-entering={entering.has(item.id)}
            style={{ left: `${spot.x}%`, top: `${spot.y}%`, rotate: `${spot.tilt}deg` }}
            aria-label={fill(copy.shelf.broughtOn, { date: dayKeyLabel(item.dayKey), place: copy.places[item.place] }) + '的' + copy.objects[item.kind]}
            aria-expanded={openId === item.id} onClick={() => setOpenId(openId === item.id ? null : item.id)}>
            <ObjectSketch kind={item.kind} className="sill-sketch" drawing={entering.has(item.id)} />
          </button>
        )
      })}
      {open && <SillNote item={open} snapshot={snapshot} onClose={() => setOpenId(null)} onOpenDiary={onOpenDiary} />}
    </>
  )
}

function SillNote({ item, snapshot, onClose, onOpenDiary }: { item: LifeView['items'][number]; snapshot: AppSnapshot; onClose: () => void; onOpenDiary: (dayKey: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !(event.target as Element).closest?.('.sill-item')) onClose() }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  const entry = snapshot.diary?.entries.find((diary) => diary.dayKey === item.dayKey)
  return (
    <div className="sill-note" data-photo-omit ref={ref} role="dialog" aria-label={copy.objects[item.kind]}>
      <strong>{copy.objects[item.kind]}</strong>
      <span>{fill(copy.shelf.broughtOn, { date: dayKeyLabel(item.dayKey), place: copy.places[item.place] })}</span>
      {entry && (entry.unlocked
        ? <button type="button" className="link-button" onClick={() => { onClose(); onOpenDiary(item.dayKey) }}>{copy.sill.diary}</button>
        : <small>{copy.sill.diaryLocked}</small>)}
    </div>
  )
}

/**
 * 这次运行里新放上窗台的 id（首个快照、重启、换 epoch 只挂载不重播，和右页卡片的入场规则一致）。
 * 一直留在集合里：属性不再变，先画线再上色的动画只播一次，后面的快照重渲染不会把它打断。
 */
function useNewIds(epoch: string, ids: readonly string[]): ReadonlySet<string> {
  const seen = useRef<{ epoch: string; initial: Set<string>; arrived: Set<string> } | null>(null)
  if (!seen.current || seen.current.epoch !== epoch) seen.current = { epoch, initial: new Set(ids), arrived: new Set() }
  for (const id of ids) if (!seen.current.initial.has(id)) seen.current.arrived.add(id)
  return seen.current.arrived
}

import type { CSSProperties } from 'react'
import copy from '../../voice/book.zh.json'
import './history.css'

export interface PhotoOverlay {
  url: string | null
  /** 隔了几天：越早越淡（体验设计 §2） */
  age: number
  /** 往回翻时一直显示；回忆时短暂换上，回忆结束淡出 */
  mode: 'page' | 'recall'
  state: 'in' | 'out'
}

/**
 * 左页上那天拍下的照片：盖在实时房间上面，但不在实时拍照的根里（data-photo-omit），
 * 以后拍新照片时不会把旧照片拍进去。没照片就明说，不按今天的素材重画过去（技术方案 §4.1）。
 */
export function HistoryPhoto({ view }: { view: PhotoOverlay }) {
  const fade = Math.min(1, Math.max(0, (view.age - 1) / 6))
  return (
    <div className="history-photo" data-photo-omit data-mode={view.mode} data-state={view.state} style={{ '--age': fade } as CSSProperties} aria-hidden={view.mode === 'recall'}>
      {view.url ? <img className="history-photo-img" src={view.url} alt="" draggable={false} /> : <p className="history-photo-missing">{copy.history.noPhoto}</p>}
    </div>
  )
}

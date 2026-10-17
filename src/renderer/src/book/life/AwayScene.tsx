import type { AppSnapshot } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { awaySceneSrc } from '../Character'
import { formatClock } from '../format'
import { fill } from './text'
import { locationLabel } from '../labels'
import { resolveAwayArt } from './awayArt'
import './away.css'

/**
 * 外出时盖在空房间上的那一页：她在外景里，桌上的纸条位置换成页面左下角的一张小纸签，
 * 写去哪、几点回来（地点和时间都由主进程定，这里只排字）。
 *
 * 动画分两种：
 * - 这次运行里亲眼看着她出门（moved）：纸条和颜色先走（WashRoom 的 leave 动画），
 *   约 1.4 s 后外景才淡进来，总时长和原来的 2.1 s 出门转场对齐；
 * - 打开书时她本来就在外面：直接显示，不重播“刚出门”。
 */
export function AwayScene({ snapshot, moved }: { snapshot: AppSnapshot; moved: boolean }) {
  const companion = snapshot.companion
  const art = resolveAwayArt(companion)
  const src = art ? awaySceneSrc(art.key) : undefined
  if (!art || !src) return null

  const place = companion.locationId
  const outing = snapshot.life?.outings.find((item) => item.status === 'away' && item.place === place)
  const notes = copy.note.went as Record<string, string>
  const went = Object.hasOwn(notes, place) ? notes[place] : fill(copy.note.wentOther, { place: locationLabel(place) })
  const back = outing ? fill(copy.note.back, { time: formatClock(outing.returnsAtMs) }) : null
  const label = fill(back ? copy.note.titleBack : copy.note.title, {
    place: locationLabel(place), time: outing ? formatClock(outing.returnsAtMs) : '',
  })

  return (
    <div className="away-scene" data-away={art.place} data-art={art.key} data-lighting={art.lighting}
      data-moved={moved || undefined}>
      <img className="away-art" src={src} alt="" draggable={false}
        style={{ objectPosition: art.focus }} />
      <div className="away-vignette" aria-hidden />
      <p className="away-caption" title={label}>
        <span className="away-caption-line">{went}</span>
        {back && <span className="away-caption-time">{back}</span>}
      </p>
    </div>
  )
}

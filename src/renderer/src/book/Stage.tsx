import { useLayoutEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { useRootAmbience } from './ambience'
import { sendCommand } from './command'
import { LeftPage } from './LeftPage'
import { QuillDock } from './quill/QuillDock'
import { RightPage } from './RightPage'
import './book.css'

const STAGE_W = 1600
const STAGE_H = 1000
const TABS = ['对话', '日程', '礼物', '日记', '设置'] as const

/** 书按固定的设计尺寸排版，整体缩放到窗口；书外露出的是书桌（美术规格 §6.1） */
function useFitScale() {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setScale(Math.min(width / STAGE_W, height / STAGE_H))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, scale }
}

export function Stage({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const { ref, scale } = useFitScale()
  const { companion } = snapshot
  useRootAmbience(companion)

  return (
    <div className="stage" ref={ref} data-mode={companion.mode} data-phase={snapshot.pomodoro.phase}
      data-pose={companion.pose} data-location={companion.locationId} data-daypart={companion.daypart} data-lights-out={companion.lightsOut}>
      <h1 className="visually-hidden">Love, College &amp; Agent</h1>
      <div className="stage-inner" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <div className="book">
          {/* 金色护角，呼应斗篷上的小金扣 */}
          {(['tl', 'tr', 'bl', 'br'] as const).map((c) => <span key={c} className={`corner corner-${c}`} aria-hidden />)}
          {/* 中缝垂下的丝带书签：就是她头发上那条 */}
          <span className="ribbon" aria-hidden />
          <LeftPage snapshot={snapshot} bridge={bridge} />
          <div className="gutter" aria-hidden />
          <RightPage snapshot={snapshot} bridge={bridge} />
          <QuillDock snapshot={snapshot} onExport={() => { void sendCommand(bridge, snapshot.epoch, { type: 'backup.export' }) }} />
          <nav className="bookmarks" aria-label="书签">
            {TABS.map((tab, i) => (
              <button key={tab} className="bookmark" data-active={i === 0} aria-current={i === 0 ? 'page' : undefined}>{tab}</button>
            ))}
          </nav>
        </div>
      </div>
    </div>
  )
}

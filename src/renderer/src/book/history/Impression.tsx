import { useEffect, useRef, useState } from 'react'
import type { OpticalMemoryRead, OpticalMemoryView } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { fill } from '../life/text'

type Frame = OpticalMemoryView['frames'][number]
const TIER_ORDER = ['large', 'base', 'small', 'tiny'] as const

/**
 * 旧页上她的印象（第三圈可选光学记忆，optical-third-circle.md）：这一页被封成几张印刷页，
 * 再按不同清晰度读回来，只留下能对上她当时看见的原话的整行残片。
 * 边界照接口：封页和残片只走用户独占的 readOpticalMemory，只在这里的状态里；清晰度不说成记忆的年龄；
 * 全部标成未审核的印象，细节以原话为准，也不能从这里引用（引用只认原话）。
 */
export function Impression({ frames, read }: { frames: readonly Frame[]; read: (frameId: string) => Promise<OpticalMemoryRead> }) {
  const pages = [...frames].sort((a, b) => a.pageIndex - b.pageIndex)
  const [index, setIndex] = useState(0)
  const frame = pages[Math.min(index, pages.length - 1)]
  const [state, setState] = useState<{ frameId: string; value: OpticalMemoryRead | null; failed: boolean } | null>(null)
  const ticket = useRef(0)
  useEffect(() => {
    if (!frame) return
    const mine = ++ticket.current
    setState({ frameId: frame.id, value: null, failed: false })
    read(frame.id).then(
      (value) => { if (ticket.current === mine) setState({ frameId: frame.id, value, failed: false }) },
      () => { if (ticket.current === mine) setState({ frameId: frame.id, value: null, failed: true }) },
    )
  }, [frame?.id])
  if (!frame) return null
  const shown = state?.frameId === frame.id ? state : null
  const impressions = [...(shown?.value?.impressions ?? [])].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))

  return (
    <div className="impression">
      <p className="old-hint">{copy.history.impression.note}</p>
      {pages.length > 1 && (
        <nav className="page-turn impression-pages" aria-label={fill(copy.history.impression.pages, { n: pages.length })}>
          <button type="button" className="link-button" disabled={index === 0} onClick={() => setIndex(index - 1)}>‹</button>
          <span>{fill(copy.history.impression.page, { i: index + 1, n: pages.length })}</span>
          <button type="button" className="link-button" disabled={index >= pages.length - 1} onClick={() => setIndex(index + 1)}>›</button>
        </nav>
      )}
      {shown?.failed ? <p className="sheet-status" role="alert">{copy.history.impression.failed}</p>
        : !shown?.value ? <p className="sheet-status" role="status">{copy.history.impression.loading}</p>
        : (
          <div className="impression-body">
            <img className="impression-sheet" src={shown.value.imageUrl} alt="" draggable={false} />
            <div className="impression-tiers">
              {impressions.map((item) => (
                <section key={item.tier} className="impression-tier" data-status={item.status}>
                  <h3>{copy.history.impression.tiers[item.tier]}</h3>
                  {item.status === 'guarded' && item.fragments.length > 0
                    ? <ul>{item.fragments.map((line, i) => <li key={i}>{line}</li>)}</ul>
                    : <p>{copy.history.impression.empty}</p>}
                  {item.rejectedLineCount > 0 && <small>{fill(copy.history.impression.rejected, { n: item.rejectedLineCount })}</small>}
                </section>
              ))}
              <p className="flow-note">{copy.history.impression.tierNote}</p>
            </div>
          </div>
        )}
    </div>
  )
}

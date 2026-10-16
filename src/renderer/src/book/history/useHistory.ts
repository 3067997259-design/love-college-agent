import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot, SessionPage, SessionPageInfo } from '../../../../shared'
import { dayNumber } from '../life/text'
import type { PhotoOverlay } from './HistoryPhoto'

export interface OldPageView { info: SessionPageInfo; page: SessionPage | null; failed: boolean }

/**
 * 往回翻：只翻前几天的页（今天这一页就是对话页）。页面内容走用户独占的 readSession，只留在这里的状态里，
 * 不进快照；换 epoch（恢复存档、换角色）就合上。连续翻页时只认最后一次请求的结果。
 */
export function useOldPages(snapshot: AppSnapshot, bridge: AppBridge) {
  const [view, setView] = useState<OldPageView | null>(null)
  const generation = useRef(0)
  const past = bridge.readSession ? (snapshot.session?.pages ?? []).filter((page) => page.sessionId !== snapshot.scope.sessionId) : []
  useEffect(() => { generation.current += 1; setView(null) }, [snapshot.epoch])

  const open = (sessionId: string) => {
    const info = past.find((page) => page.sessionId === sessionId)
    if (!info || !bridge.readSession) return
    const ticket = ++generation.current
    setView({ info, page: null, failed: false })
    bridge.readSession(sessionId).then(
      (page) => { if (generation.current === ticket) setView({ info, page, failed: false }) },
      () => { if (generation.current === ticket) setView({ info, page: null, failed: true }) },
    )
  }
  const close = () => { generation.current += 1; setView(null) }
  const neighbor = (step: -1 | 1): SessionPageInfo | null => {
    if (!view) return null
    const index = past.findIndex((page) => page.sessionId === view.info.sessionId)
    return index < 0 ? null : past[index + step] ?? null
  }
  return { view, past, open, close, neighbor }
}

/**
 * 左页该不该换成照片：往回翻到的那一页（读到了才换，读不到就留着房间，不说成“没照片”）；
 * 或者这次运行里亲眼看到她开始回忆的那一次（重启后不重播），回忆结束淡出。
 */
export function useHistoryPhoto(snapshot: AppSnapshot, old: OldPageView | null): PhotoOverlay | null {
  const watched = useRef<string | null>(null)
  const recall = snapshot.history?.recall
  if (recall?.status === 'recalling' && recall.requestId) watched.current = recall.requestId
  const today = dayNumber(snapshot.session?.dayKey ?? '')
  const age = (dayKey: string | undefined) => {
    const day = dayKey ? dayNumber(dayKey) : null
    return today !== null && day !== null ? Math.max(0, today - day) : 1
  }
  if (old?.page) return { url: old.page.photo?.imageUrl ?? null, age: age(old.info.dayKey), mode: 'page', state: 'in' }
  if (recall?.requestId && recall.requestId === watched.current && recall.photo) {
    return { url: recall.photo.imageUrl, age: age(recall.dayKey), mode: 'recall', state: recall.status === 'recalling' ? 'in' : 'out' }
  }
  return null
}

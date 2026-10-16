import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import copy from '../voice/book.zh.json'
import { useRootAmbience } from './ambience'
import { sendCommand } from './command'
import { LeftPage } from './LeftPage'
import { fill, dayKeyLabel } from './life/text'
import { QuillDock } from './quill/QuillDock'
import { introStepOf, OnboardingPage, type OnboardingStep } from '../onboarding/OnboardingPage'
import { FURNITURE } from './wash/furniture'
import { RightPage } from './RightPage'
import { DiaryBook, RibbonKey } from './sheets/DiaryBook'
import { GiftShelf } from './sheets/GiftShelf'
import { ScheduleSheet } from './sheets/ScheduleSheet'
import './book.css'
import './sheets/sheets.css'

const STAGE_W = 1600
const STAGE_H = 1000
type Tab = 'chat' | 'schedule' | 'gifts' | 'diary'
const TABS: readonly (Tab | 'settings')[] = ['chat', 'schedule', 'gifts', 'diary', 'settings']

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

export function Stage({ snapshot, bridge, onOpenTools }: { snapshot: AppSnapshot; bridge: AppBridge; onOpenTools?: () => void }) {
  const { ref, scale } = useFitScale()
  const { companion } = snapshot
  useRootAmbience(companion)
  const [step, setStep] = useState<OnboardingStep>('cover')
  const [previewDone, setPreviewDone] = useState(false)
  const needed = snapshot.onboarding?.status === 'needed' || (!previewDone && previewOnboarding() !== null)
  const onboarding = needed ? step : null
  // 新手流程里点过的家具（按先后）：左页据此一件件上色，右页列出来
  const [painted, setPainted] = useState<string[]>([])
  useLayoutEffect(() => { if (needed) { setStep('cover'); setPainted([]) } }, [needed, snapshot.scope.characterId])

  const [tab, setTab] = useState<Tab>(previewTab)
  const [diaryFocus, setDiaryFocus] = useState<string | null>(null)
  const [opened, markOpened] = useOpenedDiaries()
  // 她进入心流时，工作视图在对话页上（体验设计 §2）：不让它藏在别的书签后面
  const flowing = !!snapshot.heartFlow?.activeId
  useEffect(() => { if (flowing) setTab('chat') }, [flowing])
  const unread = useChatUnread(snapshot, tab === 'chat')
  const openDiary = (id: string) => { setTab('diary'); setDiaryFocus(id) }
  // 最近解锁的那一篇还没翻开过：钥匙夹在书签丝带上
  const latest = snapshot.diary?.entries.findLast((entry) => entry.unlocked)
  const ribbonKey = !onboarding && latest?.unlocked && !opened.has(latest.id) ? latest : null

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
          {ribbonKey && <RibbonKey label={fill(copy.diary.ribbonKey, { date: dayKeyLabel(ribbonKey.dayKey) })} onOpen={() => openDiary(ribbonKey.id)} />}
          <LeftPage snapshot={snapshot} bridge={bridge} intro={onboarding ? introStepOf(onboarding) : null}
            furniture={onboarding === 'alive' ? { painted, onPaint: (id) => setPainted((list) => list.includes(id) ? list : [...list, id]) } : undefined}
            onOpenDiary={(dayKey) => { const entry = snapshot.diary?.entries.find((item) => item.dayKey === dayKey); if (entry) openDiary(entry.id) }} />
          <div className="gutter" aria-hidden />
          {onboarding
            ? <OnboardingPage snapshot={snapshot} bridge={bridge} step={onboarding} painted={painted.map((id) => FURNITURE.find((f) => f.id === id)?.name ?? id)}
              onStep={setStep} onDone={() => setPreviewDone(true)} />
            : <>
              <RightPage snapshot={snapshot} bridge={bridge} hidden={tab !== 'chat'} onOpenShelf={() => setTab('gifts')} />
              {tab === 'gifts' && <GiftShelf snapshot={snapshot} bridge={bridge} />}
              {tab === 'diary' && <DiaryBook snapshot={snapshot} bridge={bridge} focusId={diaryFocus} onOpened={(id) => { markOpened(id); setDiaryFocus(null) }} />}
              {tab === 'schedule' && <ScheduleSheet snapshot={snapshot} />}
            </>}
          {!onboarding && <QuillDock snapshot={snapshot} onExport={() => { void sendCommand(bridge, snapshot.epoch, { type: 'backup.export' }) }} />}
          {!onboarding && (
            <nav className="bookmarks" aria-label="书签">
              {TABS.map((id) => {
                const active = id === tab
                const settings = id === 'settings'
                return (
                  <button key={id} type="button" className="bookmark" data-active={active} data-unread={id === 'chat' && unread}
                    aria-current={active ? 'page' : undefined} disabled={settings && !onOpenTools}
                    aria-label={id === 'chat' && unread ? `${copy.tabs.chat}（${copy.chatUnread}）` : undefined}
                    onClick={() => { if (settings) onOpenTools?.(); else setTab(id) }}>
                    {copy.tabs[id]}
                  </button>
                )
              })}
            </nav>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 不在对话页时，对话里来了新东西（她的话、候选、交付、礼物）：对话书签上点一个墨点。
 * 只数条目，不读内容；翻回对话就清掉。
 */
function useChatUnread(snapshot: AppSnapshot, onChat: boolean): boolean {
  const count = snapshot.messages.filter((m) => m.role === 'assistant').length + snapshot.candidates.length + snapshot.deliveries.length
    + (snapshot.gifts?.items.filter((gift) => gift.status === 'given').length ?? 0)
  const seen = useRef({ epoch: snapshot.epoch, count })
  if (onChat || seen.current.epoch !== snapshot.epoch) seen.current = { epoch: snapshot.epoch, count }
  return !onChat && count > seen.current.count
}

/** 翻开过的日记：只是“钥匙还挂不挂在书签上”的本机记号，存不了也不影响内容；正文从不落到这里 */
const OPENED_KEY = 'lca.diary.opened'
function useOpenedDiaries(): [ReadonlySet<string>, (id: string) => void] {
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(OPENED_KEY) ?? '[]') as string[]) } catch { return new Set() }
  })
  const mark = (id: string) => setOpened((current) => {
    if (current.has(id)) return current
    const next = new Set([...current, id])
    try { localStorage.setItem(OPENED_KEY, JSON.stringify([...next].slice(-200))) } catch { /* 记不住就下次再挂一次钥匙 */ }
    return next
  })
  return [opened, mark]
}

/** Browser-only art preview; real entry is owned by snapshot.onboarding. */
function previewOnboarding(): OnboardingStep | null {
  if ('lca' in window) return null
  return new URLSearchParams(location.search).has('onboarding') ? 'cover' : null
}

/** 浏览器预览可以直接翻到某个书签：?tab=gifts */
function previewTab(): Tab {
  if ('lca' in window) return 'chat'
  const tab = new URLSearchParams(location.search).get('tab')
  return tab === 'schedule' || tab === 'gifts' || tab === 'diary' ? tab : 'chat'
}

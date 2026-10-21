import { useId, useRef, useState } from 'react'
import type { ActivityView, AppSnapshot } from '../../../shared'
import { useRootAmbience } from '../book/ambience'
import { awaySceneSrc, sceneSrc } from '../book/Character'
import { resolvePackageScene } from '../book/characterPackage'
import { resolveCharacterArt } from '../book/characterArt'
import { resolveAwayArt } from '../book/life/awayArt'
import { formatRemaining } from '../book/format'
import { locationLabel } from '../book/labels'
import { useCountdown } from '../book/useCountdown'
import { activityText } from '../voice/activity-text'
import book from '../voice/book.zh.json'
import { fill } from '../book/life/text'
import './mini.css'

/**
 * 迷你陪伴窗（体验设计 §6）：专注时书合上，桌面角落只留一张纸，纸上是她坐在桌前继续做事。
 * 2026-10-16 用户批准：用当前整景图裁出她和书桌那一块，边缘羽化成纸面和铅笔线；纸以外透明、点穿，
 * 鼠标落在纸上才接收点击（窗口的置顶、透明和点穿由主进程负责）。
 * 点一下回到书本；按住纸拖动就是挪窗口，不用系统拖动区（那会和点穿的悬停判断打架）。
 * 画面只是快照的投影：姿势、表情、时段、熄灯和计时都来自主进程，这里不推任何状态。
 */

const VIEW = 300
// 整景图 1254×1254 里取她和书桌那一块：中心和边长（素材像素）。她坐在画面右半，丝带也要留在纸里
const CROP = { cx: 735, cy: 660, size: 880 }
const SCENE = 1254
const scale = VIEW / CROP.size
const IMAGE = { x: VIEW / 2 - CROP.cx * scale, y: VIEW / 2 - CROP.cy * scale, size: SCENE * scale }
// 纸的轮廓：手撕纸片似的不规则圆角，下缘留出贴计时小条的地方
const PAPER = 'M150 16 C 212 13, 266 40, 281 98 C 295 158, 283 222, 238 256 C 196 288, 118 291, 70 266 C 24 242, 9 182, 17 124 C 25 64, 86 19, 150 16 Z'
// 她手边那张卡片（新邮件）的位置，按裁切后的画面坐标
const LETTER = { x: 64, y: 214 }

export function MiniCompanion({ snapshot, onExpand, onHover, onMove }: {
  snapshot: AppSnapshot
  onExpand: () => void
  onHover: (over: boolean) => void
  /** 屏幕像素的位移；每帧最多一次，主进程负责夹在可见工作区里并记住位置 */
  onMove: (dx: number, dy: number) => void
}) {
  const { companion, pomodoro, capabilities } = snapshot
  const drag = useDragOrClick(onMove, onExpand)
  useRootAmbience(companion)
  const remaining = useCountdown(snapshot)
  const id = useId().replace(/:/g, '')
  const art = resolveCharacterArt(companion)
  // 夜景/think 整帧优先用包内精确槽位；回退基础图时改用 ambient 调色
  const packageArt = resolvePackageScene(snapshot, art)
  const imported = packageArt?.src
  // 她出门时小窗也显示同一张外景（体验设计 §6）；自定义角色包优先用包内素材，缺了才回退
  const awayArt = companion.locationId !== 'room' && !imported ? resolveAwayArt(companion) : null
  const src = imported ?? (awayArt ? awaySceneSrc(awayArt.key) : undefined) ?? sceneSrc(art.key)
  const lighting = awayArt ? awayArt.lighting : packageArt?.lighting ?? art.lighting
  const onBreak = pomodoro.phase === 'short-break' || pomodoro.phase === 'long-break'
  const away = companion.locationId !== 'room'
  const mailReady = capabilities.find((c) => c.id === 'mail')?.status === 'ready'
  const newMail = mailReady && companion.mailboxUnseen > 0 && !away
  const label = onBreak ? '休息了，点一下回到书本' : '回到书本'
  // 书合上以后，她在后台做的事只能在这里看见：专注时写一行她手上的活（和右页同一套活动模板，不调用模型）
  const doing = pomodoro.phase === 'focus' ? currentActivity(snapshot) : undefined
  // 她的工作有一步等你批准：她卡在这一步，什么阶段都要说（系统通知另由主进程按规则发）
  const approval = snapshot.question?.kind === 'approval'
  // 她自己的书桌作品：步数来自快照，不按时间推断
  const work = pomodoro.phase === 'focus' ? runningWork(snapshot) : undefined
  const plan = pomodoro.plan
  const note = approval ? book.mini.approval
    : onBreak ? '休息了，点一下回到书本'
      : doing ? activityText(doing)
        : work ? work
          : pomodoro.phase === 'idle' && plan?.status === 'confirmed' && pomodoro.focusIndex < pomodoro.plannedCount ? '下一个番茄等你开始'
            : pomodoro.phase === 'idle' && plan?.status === 'finished' && pomodoro.focusIndex >= pomodoro.plannedCount ? '今天的番茄做完了'
              : ''

  return (
    <div className="mini" data-break={onBreak} data-lights-out={companion.lightsOut}>
      <button type="button" className="mini-paper" aria-label={label} title={label}
        {...drag.handlers} onPointerEnter={() => onHover(true)} onPointerLeave={() => { if (!drag.active()) onHover(false) }}>
        <svg viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden>
          <defs>
            <filter id={`${id}-rough`} x="-5%" y="-5%" width="110%" height="110%">
              <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="3" seed="7" />
              <feDisplacementMap in="SourceGraphic" scale="9" />
            </filter>
            <radialGradient id={`${id}-fade`} cx="0.5" cy="0.47" r="0.5">
              <stop offset="0.52" stopColor="white" />
              <stop offset="0.86" stopColor="white" stopOpacity="0.35" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </radialGradient>
            <mask id={`${id}-wash`} maskContentUnits="userSpaceOnUse">
              <rect width={VIEW} height={VIEW} fill={`url(#${id}-fade)`} />
            </mask>
            <clipPath id={`${id}-clip`}><path d={PAPER} transform="translate(150 150) scale(0.96) translate(-150 -150)" /></clipPath>
          </defs>
          {/* 纸：边缘毛糙，像从本子上撕下来的一角 */}
          <path className="mini-sheet" d={PAPER} filter={`url(#${id}-rough)`} />
          <g clipPath={`url(#${id}-clip)`}>
            <g mask={`url(#${id}-wash)`}>
              {src && (awayArt
                ? <image href={src} x={0} y={0} width={VIEW} height={VIEW} preserveAspectRatio={`${awayArt.align} slice`} />
                : <image href={src} x={IMAGE.x} y={IMAGE.y} width={IMAGE.size} height={IMAGE.size} preserveAspectRatio="xMidYMid slice" />)}
              {/* 没有画内夜光的姿势，时段光和熄灯跟书本一样用调色叠上去 */}
              {lighting === 'ambient' && <rect className="mini-tint" width={VIEW} height={VIEW} />}
            </g>
          </g>
          {/* 铅笔描的纸边：铅笔是你的，颜色是她的 */}
          <path className="mini-outline" d={PAPER} filter={`url(#${id}-rough)`} />
          {newMail && (
            <g className="mini-letter" transform={`translate(${LETTER.x} ${LETTER.y}) rotate(-8)`}>
              <rect width="30" height="20" rx="2" />
              <path d="M3 4 L15 12 L27 4" />
            </g>
          )}
        </svg>
        {!src && <span className="mini-missing">（场景素材缺失）</span>}
      </button>

      {/* 铃：休息开始时摇几下，她也转过来了（姿势来自快照）。休息过了一会儿才打开小窗，铃只挂着不摇 */}
      {onBreak && <Bell key={`bell-${pomodoro.focusIndex}-${pomodoro.phase}`} ring={(pomodoro.phaseDurationMs - pomodoro.remainingMs) / Math.max(1, snapshot.clock.rate) < 4000} />}

      <p className="mini-tag">
        {companion.lightsOut ? '熄灯中'
          : pomodoro.phase === 'focus' ? <>{pomodoro.status === 'paused' ? '暂停' : '专注'} <span className="mini-time">{formatRemaining(remaining)}</span></>
            : onBreak ? <>休息 <span className="mini-time">{formatRemaining(remaining)}</span></>
              : away ? `她去${locationLabel(companion.locationId)}了` : companion.pose === 'sleeping' ? '她睡着了' : '在书桌前'}
      </p>
      <p className="mini-note" aria-live="polite" data-status={approval ? 'approval' : doing ? doing.status : work ? 'running' : undefined}>{note}</p>
    </div>
  )
}

/** 休息铃：只在这次休息刚开始（主进程计时的头几秒）时摇；挂载时定下，之后的快照不再改它 */
function Bell({ ring }: { ring: boolean }) {
  const [ringing] = useState(ring)
  return (
    <svg className="mini-bell" data-ring={ringing} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3 C 8 3, 6 6, 6 10 L 6 14 L 4 17 L 20 17 L 18 14 L 18 10 C 18 6, 16 3, 12 3 Z" />
      <circle cx="12" cy="19.5" r="1.8" />
    </svg>
  )
}

/** 她正在做的书桌作品：读哪份／照着哪份写、第几步 */
function runningWork({ life }: AppSnapshot): string | undefined {
  const work = life?.work
  const job = work?.runningId ? work.jobs.find((item) => item.id === work.runningId) : undefined
  if (!work || !job || job.status !== 'running') return undefined
  const path = work.materials.find((item) => item.id === job.materialId)?.path ?? ''
  const name = (path.split(/[\\/]/).at(-1) ?? '').replace(/\.[^.]+$/, '') || '书桌上的材料'
  return fill(book.mini.work[job.kind], { name, done: job.completedSteps, total: job.totalSteps })
}

/** 正在做的那一步优先；没有在跑的，就是当前任务最近做完的一步 */
function currentActivity({ task, activities }: AppSnapshot): ActivityView | undefined {
  const mine = task ? activities.filter((a) => a.taskId === task.id) : activities
  return [...mine].reverse().find((a) => a.status === 'running') ?? mine.at(-1)
}

/**
 * 同一张纸上分开“点一下”和“拖动”：按下后移动不到 4 px 算点击，超过就是拖动。
 * 用屏幕坐标算位移（窗口跟着鼠标走，客户区坐标几乎不变）；位移攒到下一帧再发，避免每个 pointermove 都过一次 IPC。
 * 键盘的 Enter／空格仍走 click（detail 为 0）。
 */
function useDragOrClick(onMove: (dx: number, dy: number) => void, onClick: () => void) {
  const state = useRef<{ x: number; y: number; moved: boolean; dx: number; dy: number; frame: number } | null>(null)
  const flush = () => {
    const s = state.current
    if (!s) return
    s.frame = 0
    if (s.dx || s.dy) onMove(s.dx, s.dy)
    s.dx = 0
    s.dy = 0
  }
  return {
    active: () => state.current !== null,
    handlers: {
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        state.current = { x: event.screenX, y: event.screenY, moved: false, dx: 0, dy: 0, frame: 0 }
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        const s = state.current
        if (!s) return
        const dx = event.screenX - s.x
        const dy = event.screenY - s.y
        if (!s.moved && Math.hypot(dx, dy) < 4) return
        s.moved = true
        s.x = event.screenX
        s.y = event.screenY
        s.dx += dx
        s.dy += dy
        if (!s.frame) s.frame = requestAnimationFrame(flush)
      },
      onPointerUp: () => {
        const s = state.current
        if (!s) return
        if (s.frame) cancelAnimationFrame(s.frame)
        flush()
        state.current = null
        if (!s.moved) onClick()
      },
      onPointerCancel: () => {
        const s = state.current
        if (s?.frame) cancelAnimationFrame(s.frame)
        state.current = null
      },
      onClick: (event: React.MouseEvent<HTMLElement>) => { if (event.detail === 0) onClick() },
    },
  }
}

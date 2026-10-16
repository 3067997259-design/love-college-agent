import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot, InteractionMode } from '../../../shared'
import { resolveCharacterArt } from './characterArt'
import { sendCommand, type CommandBody } from './command'
import { formatClock, formatRemaining } from './format'
import { locationLabel, MODE_LABEL } from './labels'
import { useCountdown } from './useCountdown'
import type { IntroStep } from './wash/intro'
import { FURNITURE } from './wash/furniture'
import { WashRoom } from './wash/WashRoom'

const MODES: readonly InteractionMode[] = ['work', 'quiet', 'rest']

/**
 * 左页：她在的地方（体验设计 §2）。画面是她的状态的投影，不是随机动画。
 * 她在：固定近景，像坐在她书桌旁边，状态变了她转头，镜头不动。近景每个姿势是一整张图（她、书桌、窗一起画，透视才对）。
 * 出门与睡着也保持同一近景机位；出门时在桌上纸条写明去向。
 */
// 新手流程里她先在书桌前写字，最后转过来注意到你
const INTRO_ART = { key: 'desk-writing_calm', lighting: 'ambient' } as const
const GREET_ART = { key: 'facing-user_smile', lighting: 'ambient' } as const

export function LeftPage({ snapshot, bridge, intro = null, furniture }: {
  snapshot: AppSnapshot
  bridge: AppBridge
  intro?: IntroStep | null
  /** 新手流程“她醒了”：点哪件家具，她就给哪件上色 */
  furniture?: { painted: readonly string[]; onPaint: (id: string) => void }
}) {
  const { companion, pomodoro, messages, capabilities } = snapshot
  const [commandFailed, setCommandFailed] = useState(false)
  const command = async (body: CommandBody) => {
    const result = await sendCommand(bridge, snapshot.epoch, body)
    setCommandFailed(!result.ok)
  }
  const remaining = useCountdown(snapshot)
  const away = companion.locationId !== 'room'
  const pose = away ? 'empty' : companion.pose
  const art = intro ? (intro === 'done' ? GREET_ART : INTRO_ART) : resolveCharacterArt(companion)
  const mailReady = capabilities.find((c) => c.id === 'mail')?.status === 'ready'
  const newMail = mailReady && companion.mailboxUnseen > 0
  const lastLine = [...messages].reverse().find((m) => m.role === 'assistant')
  const timerOn = pomodoro.phase !== 'idle'
  // 恢复完成后应用会重启；新页面第一次看到这次恢复，就让颜色重新长回来
  const backup = snapshot.backup
  const restoreId = backup?.status === 'restored' ? (backup.restoreId ?? backup.operationId ?? null) : null

  return (
    <section className="page page-left" aria-label="她在的地方" data-intro={intro ?? undefined}>
      {intro ? (
        <div className="room" data-shot="close" data-location="room" data-pose={art.key.split('_')[0]} data-lighting="ambient">
          <WashRoom art={art} restoreId={null} intro={intro === 'done' ? null : intro} paintFurniture={furniture?.painted} />
          {furniture && (
            <svg className="furniture-hits" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="房间里的家具">
              {FURNITURE.map((item) => {
                const done = furniture.painted.includes(item.id)
                return (
                  <polygon key={item.id} className="furniture-hit" data-done={done} points={item.points.map((p) => p.join(',')).join(' ')}
                    role="button" aria-label={done ? `${item.name}（已上色）` : `给${item.name}上色`} tabIndex={done ? -1 : 0}
                    onClick={() => { if (!done) furniture.onPaint(item.id) }}
                    onKeyDown={(event) => { if (!done && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); furniture.onPaint(item.id) } }}>
                    <title>{item.name}</title>
                  </polygon>
                )
              })}
            </svg>
          )}
        </div>
      ) : <>
      {/* 熄灯开关是页边垂下的一根拉线：她睡着、出门、门牌收起来的时候也拉得到 */}
      <button type="button" className="pull-cord" data-on={!companion.lightsOut}
        aria-label={companion.lightsOut ? '拉线开灯' : '拉线熄灯'}
        title={companion.lightsOut ? '开灯：计时和后台活动接着走' : '熄灯：暂停计时和所有后台活动'}
        onClick={() => { void command({ type: 'lights.set', lightsOut: !companion.lightsOut }) }}>
        <span className="pull-cord-string" aria-hidden><span className="pull-cord-bead" /></span>
      </button>
      <div className="room" data-shot="close" data-location={companion.locationId} data-pose={pose} data-lighting={art.lighting}>
        {/* 精修整景：颜色聚在她周围，往外褪成从彩图实时提取的铅笔线（体验设计 §7.1，用户批准） */}
        <WashRoom art={art} restoreId={restoreId} />

        {/* 墙上的钟就是番茄钟；不计时的时候显示现在几点 */}
        <div className="wall-clock" data-phase={pomodoro.phase} data-status={pomodoro.status}>
          <span className="wall-clock-time">{timerOn ? formatRemaining(remaining) : formatClock(snapshot.clock.nowMs)}</span>
          {timerOn && <span className="wall-clock-phase">{pomodoro.phase === 'focus' ? '专注' : '休息'}</span>}
        </div>
        {/* 外出用桌上纸条，睡着不挂“休息”牌。 */}
        {!away && pose !== 'sleeping' && <DoorSign snapshot={snapshot} onCommand={command} failed={commandFailed} />}
        {/* 新邮件：近景是桌上的一封信，远景是门上的信箱口。只有邮箱连着的时候才显示；连不上不能显示成“没有信” */}
        {newMail && (
          <div className="mail-slot" title={`${companion.mailboxUnseen} 封新邮件`}><span className="mail-letter" /></div>
        )}

        {away && <p className="away-note" title={`她去${locationLabel(companion.locationId)}了`}>她去{locationLabel(companion.locationId)}了</p>}

        {/* 光线层在最上面：钟、门牌、信都是房间里的东西，跟着房间一起暗 */}
        {art.lighting === 'ambient' && <><div className="room-tint" /><div className="room-lamp" /></>}
      </div>

      {lastLine && (
        <p className="speech" data-status={lastLine.status}>
          {lastLine.text}
          {lastLine.status === 'streaming' && <span className="speech-caret" />}
        </p>
      )}
      </>}
    </section>
  )
}

/**
 * 门牌是你的情境开关（体验设计 §2）：工作中／安静／休息，番茄钟的阶段会自动翻它。
 * 专注时翻到“休息”就是提前结束这一段，记为中断，由主进程判定（技术方案 §3.5）。熄灯是另一个开关，也收在这里。
 */
function DoorSign({ snapshot, onCommand, failed }: { snapshot: AppSnapshot; onCommand: (body: CommandBody) => Promise<void>; failed: boolean }) {
  const { companion, pomodoro } = snapshot
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  const pick = (body: CommandBody) => { setOpen(false); void onCommand(body) }
  const interrupts = pomodoro.phase === 'focus' && pomodoro.status !== 'idle'

  return (
    <div className="door" ref={ref}>
      <button type="button" className="door-sign" data-mode={companion.mode} aria-haspopup="menu" aria-expanded={open}
        title="门牌：点一下翻面" onClick={() => setOpen((value) => !value)}>
        {MODE_LABEL[companion.mode]}
      </button>
      {failed && <span className="notice-mark door-notice" title="没翻过去，稍后再试">！</span>}
      {open && (
        <div className="door-menu" role="menu" aria-label="门牌">
          {MODES.map((mode) => (
            <button key={mode} type="button" role="menuitemradio" aria-checked={companion.mode === mode}
              onClick={() => pick({ type: 'mode.set', mode })}>
              {MODE_LABEL[mode]}
              {mode === 'rest' && interrupts && companion.mode !== 'rest' && <small>提前结束这一段</small>}
            </button>
          ))}
          <hr />
          <button type="button" role="menuitemcheckbox" aria-checked={companion.lightsOut}
            onClick={() => pick({ type: 'lights.set', lightsOut: !companion.lightsOut })}>
            {companion.lightsOut ? '开灯' : '熄灯'}
            <small>{companion.lightsOut ? '计时和后台活动接着走' : '暂停计时和所有后台活动'}</small>
          </button>
        </div>
      )}
    </div>
  )
}

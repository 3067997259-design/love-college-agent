import type { AppSnapshot } from '../../../shared'
import closeBack from '../assets/room/close_back.webp'
import closeBackLine from '../assets/room/close_back_line.webp'
import closeFront from '../assets/room/close_front.webp'
import closeFrontLine from '../assets/room/close_front_line.webp'
import wideRoom from '../assets/room/wide_room.webp'
import wideRoomLine from '../assets/room/wide_room_line.webp'
import { Character, type Shot } from './Character'
import { formatClock, formatRemaining } from './format'
import { useCountdown } from './useCountdown'

const MODE_LABEL = { work: '工作中', quiet: '安静', rest: '休息' } as const
const LOCATION_LABEL: Record<string, string> = { shore: '海岸', swing: '秋千' }

/**
 * 左页：她在的地方（体验设计 §2）。画面是她的状态的投影，不是随机动画。
 * 她在：固定近景，像坐在她书桌斜对面，状态变了她转身，镜头不动。
 * 她不在（出门）或睡着：远景房间。她在，你就离她很近；她不在，你看到的是空房间。
 */
export function LeftPage({ snapshot }: { snapshot: AppSnapshot }) {
  const { companion, pomodoro, messages, capabilities } = snapshot
  const remaining = useCountdown(snapshot)
  const away = companion.locationId !== 'room'
  const shot: Shot = away || companion.pose === 'sleeping' ? 'wide' : 'close'
  const pose = away ? 'empty' : companion.pose
  const mailReady = capabilities.find((c) => c.id === 'mail')?.status === 'ready'
  const newMail = mailReady && companion.mailboxUnseen > 0
  const lastLine = [...messages].reverse().find((m) => m.role === 'assistant')
  const timerOn = pomodoro.phase !== 'idle'
  const layers = shot === 'close'
    ? { back: [closeBack, closeBackLine], front: [closeFront, closeFrontLine] }
    : { back: [wideRoom, wideRoomLine], front: null }

  return (
    <section className="page page-left" aria-label="她在的地方">
      <div className="room" data-shot={shot} data-location={companion.locationId} data-pose={pose}>
        {/* 下层是铅笔线稿，上层是彩色；彩色只留中间，外圈露出铅笔：铅笔是你的，颜色是她的 */}
        <div className="room-pencil">
          <img className="room-bg" src={layers.back[1]} alt="" draggable={false} />
          <Character shot={shot} pose={pose} expression={companion.expression} variant="line" />
          {layers.front && <img className="room-front" src={layers.front[1]} alt="" draggable={false} />}
        </div>
        <div className="room-color">
          <img className="room-bg" src={layers.back[0]} alt="" draggable={false} />
          <Character shot={shot} pose={pose} expression={companion.expression} />
          {layers.front && <img className="room-front" src={layers.front[0]} alt="" draggable={false} />}
        </div>

        {/* 墙上的钟就是番茄钟；不计时的时候显示现在几点 */}
        <div className="wall-clock" data-phase={pomodoro.phase} data-status={pomodoro.status}>
          <span className="wall-clock-time">{timerOn ? formatRemaining(remaining) : formatClock(snapshot.clock.nowMs)}</span>
          {timerOn && <span className="wall-clock-phase">{pomodoro.phase === 'focus' ? '专注' : '休息'}</span>}
        </div>
        {/* 门牌：近景里立在书桌上，远景里挂在门上；番茄钟的阶段会自动翻转它 */}
        <div className="door-sign" data-mode={companion.mode}>{MODE_LABEL[companion.mode]}</div>
        {/* 新邮件：近景是桌上的一封信，远景是门上的信箱口。只有邮箱连着的时候才显示；连不上不能显示成“没有信” */}
        {newMail && (
          <div className="mail-slot" title={`${companion.mailboxUnseen} 封新邮件`}><span className="mail-letter" /></div>
        )}

        {away && <p className="away-note">她去{LOCATION_LABEL[companion.locationId] ?? companion.locationId}了</p>}

        {/* 光线层在最上面：钟、门牌、信都是房间里的东西，跟着房间一起暗 */}
        <div className="room-tint" />
        <div className="room-lamp" />
      </div>

      {lastLine && (
        <p className="speech" data-status={lastLine.status}>
          {lastLine.text}
          {lastLine.status === 'streaming' && <span className="speech-caret" />}
        </p>
      )}
    </section>
  )
}

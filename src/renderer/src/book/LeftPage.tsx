import type { AppSnapshot } from '../../../shared'
import roomDay from '../assets/room/room_day.webp'
import roomDayLine from '../assets/room/room_day_line.webp'
import { Character } from './Character'
import { formatClock, formatRemaining } from './format'
import { useCountdown } from './useCountdown'

const MODE_LABEL = { work: '工作中', quiet: '安静', rest: '休息' } as const
const LOCATION_LABEL: Record<string, string> = { shore: '海岸', swing: '秋千' }

/** 左页：她在的地方（体验设计 §2）。画面是她的状态的投影，不是随机动画。 */
export function LeftPage({ snapshot }: { snapshot: AppSnapshot }) {
  const { companion, pomodoro, messages, capabilities } = snapshot
  const remaining = useCountdown(snapshot)
  const away = companion.locationId !== 'room'
  const mailReady = capabilities.find((c) => c.id === 'mail')?.status === 'ready'
  const lastLine = [...messages].reverse().find((m) => m.role === 'assistant')
  const timerOn = pomodoro.phase !== 'idle'
  const spritePose = away ? 'empty' : companion.pose

  return (
    <section className="page page-left" aria-label="她在的地方">
      <div className="room" data-location={companion.locationId} data-pose={spritePose}>
        {/* 下层是铅笔线稿，上层是彩色；彩色只留中间，外圈露出铅笔：铅笔是你的，颜色是她的 */}
        <div className="room-pencil">
          <img className="room-bg" src={roomDayLine} alt="" draggable={false} />
          <Character pose={spritePose} expression={companion.expression} variant="line" />
        </div>
        <div className="room-color">
          <img className="room-bg" src={roomDay} alt="" draggable={false} />
          <Character pose={spritePose} expression={companion.expression} />
        </div>

        {/* 墙上的钟就是番茄钟；不计时的时候显示现在几点 */}
        <div className="wall-clock" data-phase={pomodoro.phase} data-status={pomodoro.status}>
          <span className="wall-clock-time">{timerOn ? formatRemaining(remaining) : formatClock(snapshot.clock.nowMs)}</span>
          {timerOn && <span className="wall-clock-phase">{pomodoro.phase === 'focus' ? '专注' : '休息'}</span>}
        </div>
        {/* 门牌挂在门上：番茄钟的阶段会自动翻转它 */}
        <div className="door-sign" data-mode={companion.mode}>{MODE_LABEL[companion.mode]}</div>
        {/* 门上的信箱口：只有邮箱连着的时候才说有几封；连不上不能显示成“没有信” */}
        {mailReady && companion.mailboxUnseen > 0 && (
          <div className="mail-slot" title={`${companion.mailboxUnseen} 封新邮件`}><span className="mail-letter" /></div>
        )}

        {/* 她出门时，房间里是空椅子和桌上的纸条（外景页待画） */}
        {away && <p className="away-note">她去{LOCATION_LABEL[companion.locationId] ?? companion.locationId}了</p>}

        {/* 光线层在最上面：钟、门牌、信箱都是房间里的东西，跟着房间一起暗 */}
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

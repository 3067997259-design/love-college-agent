import type { AppSnapshot } from '../../../shared'
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

  return (
    <section className="page page-left" aria-label="她在的地方">
      <div className="room" data-location={companion.locationId} data-pose={companion.pose}>
        <div className="room-bg">
          <span className="room-placeholder">{away ? `${LOCATION_LABEL[companion.locationId] ?? companion.locationId}（外景待画）` : '房间插画（待画）'}</span>
        </div>
        <Character pose={companion.pose} expression={companion.expression} />

        {!away && (
          <>
            {/* 桌上的钟就是番茄钟；不计时的时候显示现在几点 */}
            <div className="desk-clock" data-phase={pomodoro.phase} data-status={pomodoro.status}>
              <span className="desk-clock-time">{timerOn ? formatRemaining(remaining) : formatClock(snapshot.clock.nowMs)}</span>
              {timerOn && <span className="desk-clock-phase">{pomodoro.phase === 'focus' ? '专注' : '休息'}</span>}
            </div>
            {/* 门牌：番茄钟的阶段会自动翻转它 */}
            <div className="door-sign" data-mode={companion.mode}>{MODE_LABEL[companion.mode]}</div>
            {/* 信箱口：只有邮箱连着的时候才说有几封；连不上不能显示成“没有信” */}
            {mailReady && companion.mailboxUnseen > 0 && (
              <div className="mail-slot" title={`${companion.mailboxUnseen} 封新邮件`}><span className="mail-letter" /></div>
            )}
          </>
        )}
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

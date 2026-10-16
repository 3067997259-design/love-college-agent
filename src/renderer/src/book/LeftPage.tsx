import type { AppSnapshot } from '../../../shared'
import { Character } from './Character'
import { resolveCharacterArt } from './characterArt'
import { formatClock, formatRemaining } from './format'
import { useCountdown } from './useCountdown'

const MODE_LABEL = { work: '工作中', quiet: '安静', rest: '休息' } as const
const LOCATION_LABEL: Record<string, string> = { shore: '海岸', swing: '秋千' }

/**
 * 左页：她在的地方（体验设计 §2）。画面是她的状态的投影，不是随机动画。
 * 她在：固定近景，像坐在她书桌旁边，状态变了她转头，镜头不动。近景每个姿势是一整张图（她、书桌、窗一起画，透视才对）。
 * 出门与睡着也保持同一近景机位；出门时在桌上纸条写明去向。
 */
export function LeftPage({ snapshot }: { snapshot: AppSnapshot }) {
  const { companion, pomodoro, messages, capabilities } = snapshot
  const remaining = useCountdown(snapshot)
  const away = companion.locationId !== 'room'
  const pose = away ? 'empty' : companion.pose
  const art = resolveCharacterArt(companion)
  const mailReady = capabilities.find((c) => c.id === 'mail')?.status === 'ready'
  const newMail = mailReady && companion.mailboxUnseen > 0
  const lastLine = [...messages].reverse().find((m) => m.role === 'assistant')
  const timerOn = pomodoro.phase !== 'idle'

  return (
    <section className="page page-left" aria-label="她在的地方">
      <div className="room" data-shot="close" data-location={companion.locationId} data-pose={pose} data-lighting={art.lighting}>
        {/* 精修整景直接淡入书页；另制匹配线稿前，不叠旧图产生重影。 */}
        <div className="room-color">
          <Character art={art} />
        </div>

        {/* 墙上的钟就是番茄钟；不计时的时候显示现在几点 */}
        <div className="wall-clock" data-phase={pomodoro.phase} data-status={pomodoro.status}>
          <span className="wall-clock-time">{timerOn ? formatRemaining(remaining) : formatClock(snapshot.clock.nowMs)}</span>
          {timerOn && <span className="wall-clock-phase">{pomodoro.phase === 'focus' ? '专注' : '休息'}</span>}
        </div>
        {/* 外出用桌上纸条，睡着不挂“休息”牌。 */}
        {!away && pose !== 'sleeping' && <div className="door-sign" data-mode={companion.mode}>{MODE_LABEL[companion.mode]}</div>}
        {/* 新邮件：近景是桌上的一封信，远景是门上的信箱口。只有邮箱连着的时候才显示；连不上不能显示成“没有信” */}
        {newMail && (
          <div className="mail-slot" title={`${companion.mailboxUnseen} 封新邮件`}><span className="mail-letter" /></div>
        )}

        {away && <p className="away-note" title={`她去${LOCATION_LABEL[companion.locationId] ?? companion.locationId}了`}>她去{LOCATION_LABEL[companion.locationId] ?? companion.locationId}了</p>}

        {/* 光线层在最上面：钟、门牌、信都是房间里的东西，跟着房间一起暗 */}
        {art.lighting === 'ambient' && <><div className="room-tint" /><div className="room-lamp" /></>}
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

import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot, InteractionMode } from '../../../shared'
import { resolveCharacterArt, type CharacterArt } from './characterArt'
import { resolveAwayArt } from './life/awayArt'
import { AwayScene } from './life/AwayScene'
import { MailMoment } from './life/MailMoment'
import { CharacterPatches } from './deltas/CharacterPatches'
import { uiSrc } from './Character'
import { sendCommand, type CommandBody } from './command'
import { formatClock, formatRemaining } from './format'
import { locationLabel, MODE_LABEL } from './labels'
import { useLightSwitch } from './ambience'
import { useLiveFlip } from './live'
import copy from '../voice/book.zh.json'
import { fill } from './life/text'
import { useCountdown } from './useCountdown'
import type { IntroStep } from './wash/intro'
import { FURNITURE } from './wash/furniture'
import { WashRoom } from './wash/WashRoom'
import { resolvePackageScene } from './characterPackage'
import { SillItems } from './life/SillItems'
import { HistoryPhoto, type PhotoOverlay } from './history/HistoryPhoto'
import { VoiceMark } from './VoiceMark'
import { voiceLevel } from '../voice/level'

const MODES: readonly InteractionMode[] = ['work', 'quiet', 'rest']

/**
 * 左页：她在的地方（体验设计 §2）。画面是她的状态的投影，不是随机动画。
 * 她在：固定近景，像坐在她书桌旁边，状态变了她转头，镜头不动。近景每个姿势是一整张图（她、书桌、窗一起画，透视才对）。
 * 出门与睡着也保持同一近景机位；出门时在桌上纸条写明去向。
 */
// 新手流程里她先在书桌前写字，最后转过来注意到你
const INTRO_ART = { key: 'desk-writing_calm', lighting: 'ambient' } as const
const GREET_ART = { key: 'facing-user_smile', lighting: 'ambient' } as const

export function LeftPage({ snapshot, bridge, intro = null, furniture, onOpenDiary, historyPhoto = null, showSpeech = true }: {
  snapshot: AppSnapshot
  bridge: AppBridge
  intro?: IntroStep | null
  /** 新手流程“她醒了”：点哪件家具，她就给哪件上色 */
  furniture?: { painted: readonly string[]; onPaint: (id: string) => void }
  /** 窗台上带回来的东西：翻到那天的日记 */
  onOpenDiary?: (dayKey: string) => void
  /** 往回翻或回忆时，那天拍下的照片盖在房间上面 */
  historyPhoto?: PhotoOverlay | null
  /** 对话页右页已经有整段话，左页不再重复字幕；声波和“停下这句”仍保留 */
  showSpeech?: boolean
}) {
  const { companion, pomodoro, messages, capabilities } = snapshot
  const [commandFailed, setCommandFailed] = useState(false)
  const command = async (body: CommandBody) => {
    const result = await sendCommand(bridge, snapshot.epoch, body)
    setCommandFailed(!result.ok)
  }
  const remaining = useCountdown(snapshot)
  const lightSwitch = useLightSwitch(companion)
  const away = companion.locationId !== 'room'
  // 这次运行里亲眼看着她出门／回来：纸条一笔笔写上；窗台上新带回的东西等她上完色再画
  const moved = useLiveFlip(snapshot.epoch, companion.locationId)
  const arriving = moved && !away
  const pose = away ? 'empty' : companion.pose
  const art: CharacterArt = intro ? (intro === 'done' ? GREET_ART : INTRO_ART) : resolveCharacterArt(companion)
  // 整帧变体（夜景/think）优先用包内精确槽位；没有时才回退基础图，并改用 ambient 调色
  const packageArt = resolvePackageScene(snapshot, art)
  const importedScene = packageArt?.src
  // 外出：左页是她在外面（体验设计 §3），复用视频冻结包里的外景；自定义角色包没有对应外景，回退包内空房间
  const awayArt = !intro && away && !importedScene ? resolveAwayArt(companion) : null
  const mailReady = capabilities.find((c) => c.id === 'mail')?.status === 'ready'
  const newMail = mailReady && companion.mailboxUnseen > 0
  const mailIcon = uiSrc('mail')
  const lastLine = [...messages].reverse().find((m) => m.role === 'assistant')
  const timerOn = pomodoro.phase !== 'idle'
  // 恢复完成后应用会重启；新页面第一次看到这次恢复，就让颜色重新长回来
  const backup = snapshot.backup
  const restoreId = backup?.status === 'restored' ? (backup.restoreId ?? backup.operationId ?? null) : null
  // 嘴型：播放器按音量给出闭／半开／张开，挂在房间上（data-mouth）。还没有张嘴差分图，先只作为接线点；直接改 DOM，不每帧重渲染
  const roomRef = useRef<HTMLDivElement>(null)
  useEffect(() => voiceLevel.subscribe((_level, mouth) => { if (roomRef.current) roomRef.current.dataset.mouth = mouth }), [])

  const scene = importedScene
    ? <div className="character character-color"><img className="character-art" data-character-package alt="" src={importedScene} draggable={false} /></div>
    : <><WashRoom art={art} restoreId={intro ? null : restoreId} intro={intro && intro !== 'done' ? intro : null} paintFurniture={intro ? furniture?.painted : undefined} lightSwitch={lightSwitch} />{awayArt && <AwayScene snapshot={snapshot} moved={moved} />}</>

  return (
    <section className="page page-left" aria-label="她在的地方" data-intro={intro ?? undefined}>
      {/* 熄灯开关是页边垂下的一根拉线：她睡着、出门、门牌收起来的时候也拉得到 */}
      {!intro && (
        <button type="button" className="pull-cord room-ui" data-on={!companion.lightsOut}
          aria-label={companion.lightsOut ? '拉线开灯' : '拉线熄灯'}
          title={companion.lightsOut ? '开灯：计时和后台活动接着走' : '熄灯：暂停计时和所有后台活动'}
          onClick={() => { void command({ type: 'lights.set', lightsOut: !companion.lightsOut }) }}>
          <span className="pull-cord-string" aria-hidden><span className="pull-cord-bead" /></span>
        </button>
      )}
      {/*
        新手流程和平常是同一个房间节点：画布不重建。点“开始吧”进书时，房间不会闪白，只把她的表情交叉淡化一次，
        钟、门牌这些房间里的东西再淡进来。
      */}
      <div ref={roomRef} className="room" data-photo-scene={intro ? undefined : true} data-session-id={intro ? undefined : snapshot.scope.sessionId} data-shot="close"
        data-location={intro ? 'room' : companion.locationId} data-pose={intro ? art.key.split('_')[0] : awayArt ? 'away' : pose} data-lighting={awayArt ? awayArt.lighting : packageArt?.lighting ?? art.lighting} data-away={awayArt ? companion.locationId : undefined} data-arriving={(!intro && arriving) || undefined}>
        {/* 精修整景：颜色聚在她周围，往外褪成从彩图实时提取的铅笔线（体验设计 §7.1，用户批准） */}
        {scene}
        {/* 差分贴片（眨眼/抬头/嘴型）：只在白天 approved 底图上贴回面部小矩形；夜里整帧重光不适用 */}
        {!intro && !awayArt && !importedScene && <CharacterPatches art={art} snapshot={snapshot} />}
        {intro ? furniture && (
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
        ) : <>
          {/* 墙上的钟就是番茄钟；不计时的时候显示现在几点 */}
          <div className="wall-clock room-ui" data-photo-omit data-phase={pomodoro.phase} data-status={pomodoro.status}>
            <span className="wall-clock-time">{timerOn ? formatRemaining(remaining) : formatClock(snapshot.clock.nowMs)}</span>
            {timerOn && <span className="wall-clock-phase">{pomodoro.phase === 'focus' ? '专注' : '休息'}</span>}
          </div>
          {/* 外出用桌上纸条，睡着不挂“休息”牌。 */}
          {!away && pose !== 'sleeping' && <DoorSign snapshot={snapshot} onCommand={command} failed={commandFailed} />}
          {/* 新邮件：近景是桌上的一封信（2026-10-17 晚换成冻结包的邮件图标），远景是门上的信箱口。只有邮箱连着的时候才显示；连不上不能显示成“没有信” */}
          {newMail && !awayArt && (
            <div className="mail-slot room-ui" title={`${companion.mailboxUnseen} 封新邮件`}>
              <span className="mail-letter" data-icon={mailIcon ? true : undefined}>
                {mailIcon ? <img className="mail-icon" src={mailIcon} alt="" draggable={false} /> : null}
              </span>
            </div>
          )}
          {/* 生活瞬间：有新邮件时，她抬头注意到信的那一刻别在页角（用户 2026-10-17 晚同意接入） */}
          {newMail && !awayArt && !historyPhoto && <MailMoment snapshot={snapshot} />}

          {away && !awayArt && <AwayNote snapshot={snapshot} writing={moved} />}
          {/* 她出门带回来的东西摆在窗台上，跟着房间一起进照片、一起变暗；外景页不是房间，不摆 */}
          {!awayArt && <SillItems snapshot={snapshot} onOpenDiary={(dayKey) => onOpenDiary?.(dayKey)} />}

          {/* 光线层在最上面：钟、门牌、信都是房间里的东西，跟着房间一起暗。重光的夜图自带光线，调色层淡出（不叠两次夜色） */}
          <div className="room-tint" /><div className="room-lamp" />
        </>}
      </div>
      {/* 房间之外的兄弟节点：盖在上面，但不进实时拍照的根 */}
      {!intro && historyPhoto && <HistoryPhoto view={historyPhoto} />}

      {!intro && lastLine && historyPhoto?.mode !== 'page' && <VoiceMark snapshot={snapshot} bridge={bridge} messageId={lastLine.id} />}
      {!intro && showSpeech && lastLine && historyPhoto?.mode !== 'page' && (
        <p className="speech" data-status={lastLine.status} data-absent={away || pose === 'sleeping' || undefined}>
          {lastLine.text}
          {lastLine.status === 'streaming' && <span className="speech-caret" />}
        </p>
      )}
    </section>
  )
}

/**
 * 桌上的纸条是她出门前写的：去哪、几点回来。地点和时间都由主进程定（life.outings），这里只排字。
 * 字贴着精修图里那张纸的透视（四角从 empty.png 量出）。这次运行里看着她出门，字才一笔笔写上；
 * 开书、重启、换 epoch 时纸条本来就在桌上，不重播。
 */
function AwayNote({ snapshot, writing }: { snapshot: AppSnapshot; writing: boolean }) {
  const place = snapshot.companion.locationId
  const outing = snapshot.life?.outings.find((item) => item.status === 'away' && item.place === place)
  const notes = copy.note.went as Record<string, string>
  const went = Object.hasOwn(notes, place) ? notes[place] : fill(copy.note.wentOther, { place: locationLabel(place) })
  const back = outing ? fill(copy.note.back, { time: formatClock(outing.returnsAtMs) }) : null
  const label = fill(back ? copy.note.titleBack : copy.note.title, { place: locationLabel(place), time: outing ? formatClock(outing.returnsAtMs) : '' })
  return (
    <p className="away-note" data-writing={writing} title={label} aria-label={label}>
      <span className="away-note-line" aria-hidden>{went}</span>
      {back && <span className="away-note-line away-note-time" aria-hidden>{back}</span>}
    </p>
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
    <div className="door room-ui" data-photo-omit ref={ref}>
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

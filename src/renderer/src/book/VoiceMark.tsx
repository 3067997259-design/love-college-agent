import { useEffect, useRef } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import words from '../voice/voice.zh.json'
import { voiceLevel } from '../voice/level'
import { useAct } from './useAct'

/**
 * 她那句话上方的小喇叭（体验设计 §5）：在说时声纹随音量起伏，点一下停下这一句；没在说时点一下静音。
 * 只认主进程和播放器回报的状态：合成中不算在说。安静、专注、熄灯、睡着时不显示——她这时本来就不出声。
 * 静音以后这里不再出现，开启语音在设置里（那里写明是 AI 合成语音）。语音失败只改为纯文字，对话不受影响。
 */
export function VoiceMark({ snapshot, bridge, messageId }: { snapshot: AppSnapshot; bridge: AppBridge; messageId: string }) {
  const voice = snapshot.voice
  const utterance = voice?.utterance?.messageId === messageId ? voice.utterance : undefined
  const act = useAct(bridge, snapshot, utterance?.id ?? 'voice')
  const bars = useRef<HTMLSpanElement>(null)
  const speaking = !!utterance && utterance.playback === 'playing' && (utterance.status === 'synthesizing' || utterance.status === 'ready')
  useEffect(() => {
    if (!speaking) return
    return voiceLevel.subscribe((level) => { bars.current?.style.setProperty('--voice-level', level.toFixed(3)) })
  }, [speaking])
  const { companion, pomodoro } = snapshot
  const hushed = companion.lightsOut || !!companion.sleeping || companion.mode === 'quiet' || pomodoro.phase === 'focus'
  if (utterance && (utterance.status === 'failed' || utterance.playback === 'failed')) return <p className="speech-voice voice-failed" role="status">{words.failed}</p>
  if (!voice?.enabled || hushed) return null
  return (
    <p className="speech-voice">
      <button type="button" className="voice-mark" data-speaking={speaking} disabled={act.busy}
        aria-label={speaking ? words.stop : words.mute} title={speaking ? `${words.speaking} · ${words.stop}` : words.mute}
        onClick={() => void act.send(speaking && utterance ? { type: 'voice.stop', utteranceId: utterance.id } : { type: 'voice.set', enabled: false })}>
        <svg viewBox="0 0 20 16" aria-hidden>
          <path className="voice-speaker" d="M2 5.5 h3.2 l4.3 -3.6 v12.2 l-4.3 -3.6 h-3.2 z" />
          {!speaking && <path className="voice-wave" d="M12.5 5 q2.2 3 0 6" />}
        </svg>
        {speaking && <span className="voice-bars" ref={bars} aria-hidden><i /><i /><i /><i /></span>}
      </button>
    </p>
  )
}

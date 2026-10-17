import { useEffect, useState } from 'react'
import type { AppSnapshot } from '../../../../shared'
import type { CharacterArt } from '../characterArt'
import { voiceLevel } from '../../voice/level'
import { deltaPatch, type DeltaPatch } from './patches'
import './deltas.css'

/**
 * 差分贴片（2026-10-17 晚接入）：眨眼、窗口 focus 抬头、说话嘴型。
 * 素材是同一张 approved 底图上的局部变体，交付时已只改面部小矩形；这里按矩形贴回原位，
 * 不整帧切换、不走晕染/交叉淡化，也不会把背景和手重新画一遍。
 *
 * 边界：
 * - 贴片来自白天的 approved 底图；夜景整帧（baked）不用贴片，所以夜里暂不眨眼/张嘴。
 * - 自定义角色包没有对应差分，自动回退到包内静态素材（这里不显示）。
 * - 嘴型只在书本播放器真的在出声时出现（voiceLevel 由唯一播放器写），没有 TTS 时保持闭嘴。
 * - 只为截图预览留 `?blink=1`、`?look=1`、`?mouth=half|open` 三个查询参数；正常窗口没有这些参数。
 */

type Mouth = 'closed' | 'half' | 'open'

const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search)
const previewBlink = params?.get('blink') === '1'
const previewNoBlink = params?.get('no-blink') === '1'
const previewLook = params?.get('look') === '1'
const previewMouth = params?.get('mouth')

/** 每 2–6 秒随机眨一次，每次约 160 ms；用 rAF + performance.now，不碰被 lint 禁用的计时器。 */
function useRandomBlink(enabled: boolean): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    setVisible(false)
    if (!enabled) return
    if (previewBlink) { setVisible(true); return }
    let raf = 0
    let on = false
    let end = 0
    let next = performance.now() + 1200 + Math.random() * 2200
    const tick = (now: number) => {
      if (on && now >= end) { on = false; setVisible(false) }
      if (!on && now >= next) {
        on = true
        end = now + 160
        setVisible(true)
        next = end + 2200 + Math.random() * 3800
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled])
  return enabled && visible
}

/** 窗口获得焦点时抬眼看一下；约 1.6 秒后回到纸面（体验设计 §3）。 */
function useFocusGlance(enabled: boolean): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    setVisible(false)
    if (!enabled) return
    if (previewLook) { setVisible(true); return }
    let raf = 0
    let on = false
    let end = 0
    const tick = (now: number) => {
      if (on && now >= end) { on = false; setVisible(false) }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const start = () => { on = true; end = performance.now() + 1600; setVisible(true) }
    window.addEventListener('focus', start)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('focus', start) }
  }, [enabled])
  return enabled && visible
}

export function CharacterPatches({ art, snapshot }: { art: CharacterArt; snapshot: AppSnapshot }) {
  const baseKey = art.baseKey ?? art.key
  const ambient = art.lighting === 'ambient'
  const awake = snapshot.companion.pose !== 'sleeping' && !snapshot.companion.lightsOut
  const [mouth, setMouth] = useState<Mouth>(previewMouth === 'half' ? 'half' : previewMouth === 'open' ? 'open' : 'closed')
  useEffect(() => {
    if (previewMouth === 'half' || previewMouth === 'open') return
    return voiceLevel.subscribe((_level, next) => setMouth(next as Mouth))
  }, [])

  const blinkPatch = ambient ? deltaPatch(baseKey, 'blink') : undefined
  const lookPatch = ambient && baseKey === 'desk-writing_calm' ? deltaPatch(baseKey, 'look-up') : undefined
  const mouthKey = mouth === 'half' ? 'mouth-half' : mouth === 'open' ? 'mouth-open' : null
  const mouthPatch = ambient && mouthKey ? deltaPatch(baseKey, mouthKey) : undefined

  const blinking = useRandomBlink(!!blinkPatch && awake && !previewNoBlink)
  const looking = useFocusGlance(!!lookPatch && awake)

  return (
    <>
      {blinking && !looking && blinkPatch && <Patch patch={blinkPatch} kind="blink" />}
      {looking && lookPatch && <Patch patch={lookPatch} kind="look-up" />}
      {mouthPatch && <Patch patch={mouthPatch} kind={`mouth-${mouth}`} />}
    </>
  )
}

function Patch({ patch, kind }: { patch: DeltaPatch; kind: string }) {
  return (
    <img className="delta-patch" data-kind={kind} data-patch={patch.id} data-photo-omit src={patch.src} alt="" draggable={false}
      style={{ left: `${patch.left}%`, top: `${patch.top}%`, width: `${patch.width}%`, height: `${patch.height}%` }} />
  )
}

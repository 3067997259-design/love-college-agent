/**
 * 她说话时的音量（0–1）和对应的嘴型档位。只由书本里唯一的播放器（player.ts）写，
 * 界面订阅后直接改 DOM（CSS 变量、data 属性），不让整页每帧重渲染。
 * 现在还没有张嘴差分图：嘴型档位挂在房间的 data-mouth 上，声纹按电平起伏；以后有了差分图，按档位换图即可。
 */
export type Mouth = 'closed' | 'half' | 'open'
type Listener = (level: number, mouth: Mouth) => void

let level = 0
const listeners = new Set<Listener>()

export const mouthOf = (value: number): Mouth => value < 0.06 ? 'closed' : value < 0.22 ? 'half' : 'open'

/** 张嘴跟得快、合嘴慢一点，像说话；静下来归零 */
export function smoothLevel(previous: number, input: number): number {
  const next = Math.min(1, Math.max(0, input))
  const value = next > previous ? next : previous * 0.82 + next * 0.18
  return value < 0.005 ? 0 : value
}

export const voiceLevel = {
  get: () => level,
  set(input: number) {
    level = smoothLevel(level, input)
    for (const listener of listeners) listener(level, mouthOf(level))
  },
  reset() {
    level = 0
    for (const listener of listeners) listener(0, 'closed')
  },
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

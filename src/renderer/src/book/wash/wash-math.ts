/**
 * 左页过渡的小工具：时间比例，以及换图时用哪种过渡。纯函数，单测直接引用。
 * （从一点往外扩的半径曲线已经不用：2026-10-16 起所有上色都是笔触，见 painter.ts。）
 */

/** 进度 0–1；超过时长就是 1 */
export function washProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1
  return Math.min(1, Math.max(0, elapsedMs / durationMs))
}

/** 两头慢、中间快：淡入淡出用 */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

export type Lighting = 'ambient' | 'baked-night' | 'baked-dark'
export interface ArtRef { key: string; lighting: Lighting }

/**
 * - none：第一次画或同一张图
 * - crossfade：同一姿势换表情，或拉灯（开关灯是一下子的事）
 * - fade：光线变了（天黑、睡着、醒来）整间屋都在变，慢慢淡过去。
 *   重光的夜图和白天的空房间处处不同，按剪影重画会把整间屋当成她，所以这时不重画。
 * - leave：她出门，颜色先跟她走，铅笔影子留一会儿再散
 * - arrive：她回来，先出线稿再一笔一笔上色，比平常换姿势慢
 * - wash：其余换姿势，只把她重画一遍
 */
export type TransitionKind = 'none' | 'crossfade' | 'fade' | 'leave' | 'arrive' | 'wash'

export function transitionKind(previous: ArtRef | null, next: ArtRef, lightSwitch = false): TransitionKind {
  if (!previous || previous.key === next.key) return 'none'
  const from = poseOf(previous.key)
  const to = poseOf(next.key)
  const ambient = previous.lighting === 'ambient' && next.lighting === 'ambient'
  if (lightSwitch && from === to) return 'crossfade'
  if (to === 'empty' && from !== 'empty') return ambient ? 'leave' : 'fade'
  if (from === 'empty' && to !== 'empty') return ambient ? 'arrive' : 'fade'
  if (previous.lighting !== next.lighting) return from === to && previous.lighting !== 'ambient' && next.lighting !== 'ambient' ? 'crossfade' : 'fade'
  if (from === to) return 'crossfade'
  return ambient ? 'wash' : 'fade'
}

export const poseOf = (key: string) => key.split('_')[0]

/** 出门时她的铅笔影子：0.25 s 浮出来，颜色走完（LEAVE_COLOR_MS）后再用 1.2 s 散掉 */
export const LEAVE_COLOR_MS = 900
export const LEAVE_TOTAL_MS = 2100
export function ghostAlpha(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0
  if (elapsedMs < 250) return easeInOut(elapsedMs / 250)
  if (elapsedMs < LEAVE_COLOR_MS) return 1
  return 1 - easeInOut((elapsedMs - LEAVE_COLOR_MS) / (LEAVE_TOTAL_MS - LEAVE_COLOR_MS))
}

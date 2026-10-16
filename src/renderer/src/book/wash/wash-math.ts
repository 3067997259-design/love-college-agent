/**
 * 左页过渡的小工具：时间比例，以及换图时该交叉淡化还是重画她。纯函数，单测直接引用。
 * （从一点往外扩的半径曲线已经不用：2026-10-16 起所有上色都是笔触，见 painter.ts。）
 */

/** 进度 0–1；超过时长就是 1 */
export function washProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1
  return Math.min(1, Math.max(0, elapsedMs / durationMs))
}

/** 同一姿势只换表情或光照时交叉淡化，换姿势才重画她 */
export function transitionKind(previousKey: string | null, nextKey: string): 'none' | 'crossfade' | 'wash' {
  if (previousKey === null || previousKey === nextKey) return 'none'
  return poseOf(previousKey) === poseOf(nextKey) ? 'crossfade' : 'wash'
}

export const poseOf = (key: string) => key.split('_')[0]

import type { LifeView, LifeWorkItem } from '../../../../shared'

/** 跨日以后仍要你处理的作品：在跑、停下、被打断（跨日重启会恢复成 interrupted）、还排着的 */
const UNFINISHED: ReadonlySet<LifeWorkItem['status']> = new Set(['queued', 'running', 'paused', 'interrupted'])

/**
 * 日程页“她今天”列出的书桌作品：今天的全部，加上前几天没做完的。
 * 只按今天过滤会把跨日重启后变成 interrupted 的旧作品藏起来，“接着做”和“看看”一起消失（GitHub #18）。
 */
export function visibleWorks(life: Pick<LifeView, 'dayKey' | 'work'> | undefined): LifeWorkItem[] {
  return (life?.work?.jobs ?? []).filter((job) => job.dayKey === life?.dayKey || UNFINISHED.has(job.status))
}

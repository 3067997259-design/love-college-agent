import type { LifeView, LifeWorkItem } from '../../../../shared'

/**
 * 日程页“她今天”列出的书桌作品：今天的全部，加上前几天还没做完的（除了做完的都留着，失败的也让你看见）。
 * 只按今天过滤会把跨日重启后变成 interrupted 的旧作品藏起来，“接着做”和“看看”一起消失（GitHub #18，两条线的修复合在一起）。
 */
export function visibleWorks(life: Pick<LifeView, 'dayKey' | 'work'> | undefined): LifeWorkItem[] {
  return (life?.work?.jobs ?? []).filter((job) => job.dayKey === life?.dayKey || job.status !== 'completed')
}

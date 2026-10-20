import type { ActivityView } from '../../../shared'
import templates from './activities.zh.json'

type Table = Record<string, Record<string, string>>
const table = templates as unknown as Table

/** 折叠时用的种类名：模板“进行中”那句；带占位符的不用。 */
export function activityKind(view: ActivityView): string | null {
  const running = table[view.templateId]?.running
  return running && !running.includes('{') ? running : null
}

/** 活动小字：先找 模板.状态:zero（数量为 0 时），再找 模板.状态，最后退回通用句。缺字段的模板也退回通用句。 */
export function activityText(view: ActivityView): string {
  const entry = table[view.templateId] ?? {}
  const zero = Object.values(view.fields).some((v) => v === 0) ? entry[`${view.status}:zero`] : undefined
  const template = zero ?? entry[view.status]
  const filled = template?.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = view.fields[key]
    return value === undefined || value === '' ? '\u0000' : String(value)
  })
  if (filled && !filled.includes('\u0000')) return filled
  return table._fallback[view.status] ?? table._fallback.unknown
}

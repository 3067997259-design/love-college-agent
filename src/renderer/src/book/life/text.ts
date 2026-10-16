import type { AppSnapshot, GeneratedGiftView } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { civilFromDays, parseIso } from '../format'

/** 文案里的 {名字} 换成值 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

/** 'YYYY-MM-DD' → 10月17日（周六），日期由主进程按上海时间给出 */
export function dayKeyLabel(dayKey: string, weekday = false): string {
  const parts = parseIso(`${dayKey}T00:00+08:00`)
  if (!parts) return dayKey
  return `${parts.month}月${parts.day}日${weekday ? ` ${parts.weekday}` : ''}`
}

/** 'YYYY-MM-DD' → 1970-01-01 起的天数（civil_from_days 的反函数），用来算旧页隔了几天 */
export function dayNumber(dayKey: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!m) return null
  const month = Number(m[2]); const day = Number(m[3]); const year = Number(m[1]) - (month <= 2 ? 1 : 0)
  const era = Math.floor(year / 400); const yoe = year - era * 400
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468
}

/** 毫秒时间戳 → 10月17日（UTC+8） */
export function dateLabel(ms: number): string {
  const { month, day } = civilFromDays(Math.floor((ms + 8 * 3600_000) / 86_400_000))
  return `${month}月${day}日`
}

export function giftName(gift: Pick<GeneratedGiftView, 'objectId' | 'motif'>): string {
  return copy.motifs[gift.motif] + copy.objects[gift.objectId]
}

/** 礼物来自哪段经历：只取快照里已有的记忆条目文字，找不到就不编 */
export function sourceText(snapshot: AppSnapshot, memoryId: string): string | null {
  return snapshot.memory?.items.find((item) => item.id === memoryId)?.text ?? null
}

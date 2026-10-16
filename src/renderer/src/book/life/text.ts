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

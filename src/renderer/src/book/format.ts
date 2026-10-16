/**
 * 展示用的时间格式化。渲染层不用 Date（统一时钟规则），这里只做字符串和整数运算。
 * 首版只按快照里的时区 Asia/Shanghai（UTC+8，无夏令时）显示。
 */
const OFFSET_MS = 8 * 3600_000
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Sakamoto 算法：公历日期 → 星期（0 = 周日） */
function weekday(y: number, m: number, d: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  if (m < 3) y -= 1
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[m - 1] + d) % 7
}

const pad = (n: number) => String(n).padStart(2, '0')

export interface DateParts { year: number; month: number; day: number; hour: number; minute: number; weekday: string }

/** 解析 2026-10-26T23:59:00+08:00 这类带偏移的 ISO 串；只接受 +08:00，其他偏移返回 null，不猜 */
export function parseIso(iso: string): DateParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(\+08:00)$/.exec(iso)
  if (!m) return null
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number)
  return { year, month, day, hour, minute, weekday: WEEKDAYS[weekday(year, month, day)] }
}

/** 10月26日 周一 23:59 */
export function formatIso(iso: string | null | undefined): string {
  if (!iso) return '—'
  const p = parseIso(iso)
  if (!p) return iso // 解析不了就原样显示，宁可难看也不显示错的时间
  return `${p.month}月${p.day}日 ${p.weekday} ${pad(p.hour)}:${pad(p.minute)}`
}

/** 毫秒时间戳 → 14:45（UTC+8） */
export function formatClock(ms: number): string {
  const minutes = Math.floor((ms + OFFSET_MS) / 60_000) % (24 * 60)
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/** 毫秒时间戳 → 10月17日 14:20（UTC+8） */
export function formatDateTime(ms: number): string {
  const { month, day } = civilFromDays(Math.floor((ms + OFFSET_MS) / 86_400_000))
  return `${month}月${day}日 ${formatClock(ms)}`
}

/** Howard Hinnant 的 civil_from_days：1970-01-01 起的天数 → 公历日期 */
export function civilFromDays(z: number) {
  z += 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day }
}

/** 剩余毫秒 → 04:59 */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

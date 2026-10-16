import type { Daypart } from '../../shared'

export interface DaypartSchedule { morningStartHour: number; dayStartHour: number; eveningStartHour: number; nightStartHour: number }
/** Implementation defaults, not a fixed product decision; a routine owner can supply alternatives. */
export const DEFAULT_DAYPART_SCHEDULE: DaypartSchedule = { morningStartHour: 6, dayStartHour: 12, eveningStartHour: 17, nightStartHour: 20 }

export function deriveDaypart(timestampMs: number, schedule = DEFAULT_DAYPART_SCHEDULE, timeZone = 'Asia/Shanghai'): Daypart {
  const boundaries = [schedule.morningStartHour, schedule.dayStartHour, schedule.eveningStartHour, schedule.nightStartHour]
  if (!boundaries.every((value, index) => Number.isFinite(value) && value >= 0 && value < 24 && (index === 0 || value > boundaries[index - 1]))) throw new Error('Invalid daypart schedule.')
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestampMs)
  const hour = Number(parts.find((part) => part.type === 'hour')!.value) + Number(parts.find((part) => part.type === 'minute')!.value) / 60
  if (hour < schedule.morningStartHour || hour >= schedule.nightStartHour) return 'night'
  if (hour < schedule.dayStartHour) return 'morning'
  if (hour < schedule.eveningStartHour) return 'day'
  return 'evening'
}

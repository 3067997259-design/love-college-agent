import type { Clock } from '../clock'
import type { CampusItem } from './projection'

const text = (value: string) => value.replaceAll('\\', '\\\\').replace(/\r\n|\r|\n/g, '\\n').replaceAll(';', '\\;').replaceAll(',', '\\,')
/** RFC 5545 folds by UTF-8 octets, never inside a code point. */
export function foldLine(value: string): string {
  let line = ''; let size = 0; const lines: string[] = []
  for (const char of value) {
    const width = Buffer.byteLength(char, 'utf8')
    if (size + width > 75) { lines.push(line); line = ' '; size = 1 }
    line += char; size += width
  }
  lines.push(line); return lines.join('\r\n')
}
export function exportCampusItem(item: CampusItem, clock: Clock): { ics: string; md: string } {
  const candidate = item.accepted
  if (!candidate || candidate.status !== 'confirmed' || item.acceptedAtMs === undefined) throw new Error('EXPORT_UNCONFIRMED')
  const utc = (ms: number) => {
    const iso = clock.iso(ms)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) throw new Error('EXPORT_DATE_INVALID')
    return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  }
  const start = candidate.kind === 'event' ? candidate.eventStartIso : candidate.deadlineIso
  if (!start) throw new Error('EXPORT_DATE_MISSING')
  const description = [candidate.source === 'fake' ? '合成邮件开发数据' : '已确认校园事项', candidate.sourceLabel,
    ...(candidate.deadlineIso ? ['原始截止：' + candidate.deadlineIso] : []),
    ...(candidate.plannedCompletionIso ? ['计划完成：' + candidate.plannedCompletionIso] : []), '仅生成本地文件，尚未写入外部日历。'].join('\n')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Love College Agent//Campus Export 1.0//ZH', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', 'UID:' + item.calendarUid + '@love-college-agent.local', 'SEQUENCE:' + item.sequence,
    'DTSTAMP:' + utc(item.acceptedAtMs), 'CREATED:' + utc(item.originalCreatedAtMs), 'LAST-MODIFIED:' + utc(item.acceptedAtMs),
    'DTSTART:' + utc(clock.parse(start)), ...(candidate.kind === 'event' && candidate.eventEndIso ? ['DTEND:' + utc(clock.parse(candidate.eventEndIso))] : []),
    'SUMMARY:' + text(candidate.title), 'DESCRIPTION:' + text(description), ...(candidate.locationText ? ['LOCATION:' + text(candidate.locationText)] : []),
    'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR']
  // Indented text stays literal even when a validated short field contains Markdown punctuation.
  const md = ['# 已确认校园事项', '', '    ' + candidate.title, '', ...description.split('\n').map((line) => '    ' + line), '',
    ...(candidate.eventStartIso ? ['活动开始：' + candidate.eventStartIso] : []), ...(candidate.eventEndIso ? ['活动结束：' + candidate.eventEndIso] : []),
    ...(candidate.locationText ? ['地点：', '    ' + candidate.locationText] : []),
    '日历 UID：' + item.calendarUid + '@love-college-agent.local', 'SEQUENCE：' + item.sequence, '',
    '改期沿用同一 UID；手机日历如何处理重新导入仍需实测。', ''].join('\n')
  return { ics: lines.map(foldLine).join('\r\n') + '\r\n', md }
}

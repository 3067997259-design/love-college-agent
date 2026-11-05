import { useEffect, useState } from 'react'
import type { AppBridge, AppSnapshot, DiaryRead } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { sendCommand } from '../command'
import { SettingsIssue } from '../../tools/SettingsIssue'
import { dayKeyLabel } from '../life/text'

/**
 * 日记（技术方案 §3.16）：她每天写，加密放在自己的文件夹里；写好的那一页会把钥匙夹进书签丝带。
 * 她偶尔会把某一页先折起来，过一晚再给人看。正文和钥匙只走用户独占的 readDiary，
 * 只留在这一页的状态里：不进快照、不存本地、不发给她。
 */
export function DiaryBook({ snapshot, bridge, focusId, onOpened }: {
  snapshot: AppSnapshot
  bridge: AppBridge
  /** 从书签上的钥匙、窗台小物点进来时直接翻到的那一篇 */
  focusId: string | null
  onOpened: (id: string) => void
}) {
  const diary = snapshot.diary
  const [reading, setReading] = useState<DiaryRead | null>(null)
  const [error, setError] = useState('')

  async function open(id: string) {
    setError('')
    if (!bridge.readDiary) { setError(copy.diary.readFailed); return }
    try {
      setReading(await bridge.readDiary(id))
      onOpened(id)
    } catch { setError(copy.diary.readFailed) }
  }
  // 恢复存档、换角色以后，手上这一页作废
  useEffect(() => { setReading(null); setError('') }, [snapshot.epoch])
  // 只跟着跳转目标变：从钥匙或窗台点进来时翻到那一篇
  useEffect(() => {
    if (focusId && diary?.entries.some((entry) => entry.id === focusId && entry.unlocked)) void open(focusId)
  }, [focusId])

  const status = diary?.status === 'writing' ? copy.diary.writing : diary?.status === 'unconfigured' ? copy.diary.unconfigured : diary?.status === 'failed' ? copy.diary.failed : null
  const entries = [...(diary?.entries ?? [])].reverse()
  // 早期版本的日记按提示词在第一行写了「主观日记」；那一行不该出现在她的私人文里。
  const lines = reading ? reading.text.split('\n') : []
  const body = lines.length > 1 && lines[0].trim().startsWith(copy.diary.subjective) ? lines.slice(1) : lines

  return (
    <section className="page page-right sheet sheet-diary" aria-label={copy.diary.title}>
      <header className="page-head">
        <span className="page-date">{reading ? dayKeyLabel(reading.dayKey, true) : copy.diary.title}</span>
        <span className="sheet-lead">{reading ? copy.diary.readingTitle : copy.diary.lead}</span>
      </header>
      {reading ? (
        <div className="sheet-body diary-page">
          <div className="diary-text">
            {body.map((line, index) => <p key={index}>{line}</p>)}
          </div>
          <div className="card-actions"><button type="button" className="btn btn-ghost btn-small" onClick={() => setReading(null)}>{copy.diary.close}</button></div>
        </div>
      ) : (
        <div className="sheet-body">
          {status && <p className="sheet-status">{status}</p>}
          {diary?.status === 'failed' && <button type="button" className="btn btn-ghost btn-small" onClick={() => { void sendCommand(bridge, snapshot.epoch, { type: 'diary.write' }).then((result) => setError(result.ok ? '' : result.code)) }}>{copy.diary.retry}</button>}
          {entries.length === 0 ? <p className="sheet-empty">{copy.diary.empty}</p> : (
            <ul className="diary-list">
              {entries.map((entry) => (
                <li key={entry.id} className="diary-row" data-unlocked={entry.unlocked}>
                  <span className="diary-date">{dayKeyLabel(entry.dayKey, true)}</span>
                  {entry.unlocked
                    ? <button type="button" className="btn btn-primary btn-small" onClick={() => { void open(entry.id) }}>{copy.diary.open}</button>
                    : <span className="diary-lock">{copy.diary.locked}</span>}
                </li>
              ))}
            </ul>
          )}
          {error && (error === copy.diary.readFailed ? <p className="sheet-status" role="alert">{error}</p> : <SettingsIssue code={error} />)}
        </div>
      )}
    </section>
  )
}

/** 书签上的小钥匙（技术方案 §3.16“随进度解锁”）：最新一篇解锁了、你还没翻开过，就挂在丝带上 */
export function RibbonKey({ label, onOpen, arriving = false }: { label: string; onOpen: () => void; arriving?: boolean }) {
  return (
    <button type="button" className="ribbon-key" data-arriving={arriving} aria-label={label} title={label} onClick={onOpen}>
      <svg viewBox="0 0 22 44" aria-hidden>
        <path d="M11 0 V8" stroke="var(--navy)" strokeWidth="1.2" />
        <g fill="#e3c785" stroke="#6b5426" strokeWidth="1.1" strokeLinejoin="round">
          <circle cx="11" cy="13.5" r="5.5" />
          <path d="M9.6 18.6 h2.8 V37 l1 1.2 -1 1.2 1 1.2 -1.4 1.4 h-2.4 Z" />
          <path d="M12.4 31 h3.4 v2.6 h-3.4 M12.4 35.4 h2.4 v2.2" fill="none" />
        </g>
        <circle cx="11" cy="13.5" r="2" fill="var(--paper)" stroke="#6b5426" strokeWidth="1" />
      </svg>
    </button>
  )
}

import type { AppSnapshot } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { fill } from './text'
import { momentSrc, uiSrc } from '../Character'
import './moments.css'

/**
 * 有新邮件时别在页角的一张快照（2026-10-17 晚接的生活瞬间）：
 * 素材来自视频冻结包里她抬头注意到信的那一刻；数量只来自主进程快照（mailboxUnseen），
 * 邮箱没连通时 `newMail` 为 false，不出现——不能把“连不上”画成“有信”。
 * 快照是界面，不是房间里的东西：拍历史照片时排除（data-photo-omit），点它不触发任何命令。
 */
export function MailMoment({ snapshot }: { snapshot: AppSnapshot }) {
  const count = snapshot.companion.mailboxUnseen
  if (count <= 0) return null
  const photo = momentSrc('first-notice')
  const icon = uiSrc('mail')
  if (!photo) return null
  const title = fill(copy.mailMoment.count, { count })
  return (
    <div className="mail-moment" data-photo-omit title={`${copy.mailMoment.title} · ${title}`}>
      <img className="mail-moment-photo" src={photo} alt={copy.mailMoment.photoAlt} draggable={false} />
      <span className="mail-moment-caption">
        {icon && <img className="mail-moment-icon" src={icon} alt="" draggable={false} />}
        {copy.mailMoment.title}
        <b>{title}</b>
      </span>
    </div>
  )
}

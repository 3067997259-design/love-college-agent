import type { AppSnapshot } from '../../../../shared'
import { formatClock } from '../format'
import { QuillArt } from './QuillArt'
import './quill.css'

/**
 * 私人存档在界面上就是这支羽毛笔（体验设计 §2 书签“数据”、技术方案 §5）：
 * 她送出来以后夹在书缝里，点一下就从它导出存档。没收到笔之前，设置页里照样能导出。
 * 导出用主进程的原生对话框；这里只发命令、显示进行中和结果，不碰路径和字节。
 */
export function QuillDock({ snapshot, onExport }: { snapshot: AppSnapshot; onExport: () => void }) {
  const { quill, backup } = snapshot
  if (quill?.state !== 'given') return null
  const status = backup?.status ?? 'idle'
  const busy = status === 'exporting' || status === 'validating' || status === 'restoring'
  const note = status === 'exporting' ? '正在写存档…'
    : status === 'exported' && backup?.exportedAtMs ? `存档写好了 · ${formatClock(backup.exportedAtMs)}`
      : status === 'failed' && backup?.error && backup.error.code !== 'restore-failed' ? '这次没写成，再点一下重试'
        : ''
  return (
    <div className="quill-dock" data-status={status}>
      <button type="button" className="quill-button" aria-label="羽毛笔 · 导出存档" title="羽毛笔：从这里导出私人存档" disabled={busy} onClick={onExport}>
        <QuillArt className="quill-svg" />
      </button>
      <span className="quill-tag" aria-hidden>{busy ? '正在写…' : '记下此刻（导出存档）'}</span>
      {note && (
        <span className="quill-note" data-failed={status === 'failed'}>
          {status === 'failed' && <span className="notice-mark" title={backup?.error?.detailsId ? `诊断编号 ${backup.error.detailsId}` : undefined}>！</span>}
          {note}
        </span>
      )}
    </div>
  )
}

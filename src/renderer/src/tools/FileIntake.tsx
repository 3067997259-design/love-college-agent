import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import './documents.css'

export function FileIntake({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const input = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!bridge.importFiles) return
    const dragover = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault() }
    const drop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (!files.length) return
      event.preventDefault(); event.stopPropagation()
      void bridge.importFiles!(files, snapshot.epoch).then((ack) => { setError(!!ack.error); setNotice(ack.error ? `文件未全部接收：${ack.error.code}` : `已接收 ${ack.acceptedIds.length} 份资料`) }, () => { setError(true); setNotice('文件接收失败') })
    }
    window.addEventListener('dragover', dragover); window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragover', dragover); window.removeEventListener('drop', drop) }
  }, [bridge, snapshot.epoch])
  if (!bridge.importFiles || !snapshot.documents) return null
  return <div className="file-intake">
    <button type="button" className="file-clip" aria-label="递给她一份资料" title="递给她一份资料" onClick={() => input.current?.click()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 11.8l5.9-5.9a3.4 3.4 0 014.8 4.8l-7.6 7.6a5.1 5.1 0 01-7.2-7.2l7.3-7.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
    </button>
    <input ref={input} className="visually-hidden" type="file" multiple accept=".pdf,.txt,.md" aria-label="选择资料文件" onChange={(event) => {
      const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''
      if (files.length) void bridge.importFiles!(files, snapshot.epoch).then((ack) => { setError(!!ack.error); setNotice(ack.error ? `文件未全部接收：${ack.error.code}` : `已接收 ${ack.acceptedIds.length} 份资料`) }, () => { setError(true); setNotice('文件接收失败') })
    }} />
    <span className="file-hint">可拖入 PDF／文本 · {snapshot.privacy.fileFilteringEnabled ? '滤芯整理' : snapshot.runtime?.developer.mode === 'developer' ? '暂存，等待开启 /privacy' : snapshot.modelSettings?.configuredSlots.includes('chat') ? '主模型直接整理' : '暂存，等待模型连接'}</span>
    {notice && <span role={error ? 'alert' : 'status'} className="file-notice">{notice}</span>}
  </div>
}

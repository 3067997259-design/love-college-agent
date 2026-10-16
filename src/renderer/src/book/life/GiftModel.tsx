import { useEffect, useRef } from 'react'
import '@google/model-viewer'
import type { GeneratedGiftView } from '../../../../shared'

/**
 * 礼物的 3D 模型：只读主进程给的本地受限地址（assetUrl），不碰上游链接。
 * 可以拖着转；不自动旋转，免得和左页的安静抢注意力。
 */
export function GiftModel({ gift, label, className }: { gift: GeneratedGiftView; label: string; className?: string }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = root.current
    if (!gift.assetUrl || !host) return
    const model = document.createElement('model-viewer')
    model.setAttribute('src', gift.assetUrl)
    model.setAttribute('camera-controls', '')
    model.setAttribute('interaction-prompt', 'none')
    model.setAttribute('shadow-intensity', '0.6')
    model.setAttribute('exposure', '1.05')
    model.setAttribute('alt', label)
    model.addEventListener('load', () => { model.dataset.loaded = 'true' })
    host.append(model)
    return () => model.remove()
  }, [gift.assetUrl, label])
  return <div ref={root} className={className} />
}

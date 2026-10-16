import { useEffect, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { connectBridge } from '../app/connect-bridge'
import { ScenarioSwitcher } from '../dev/ScenarioSwitcher'
import type { FakeBridge } from '../dev/fake-bridge'
import { MiniCompanion } from './MiniCompanion'

/**
 * 迷你窗的根：主进程用 ?view=mini 载入同一套渲染代码，走同一个 bridge。
 * “回到书本”“鼠标在纸上”“挪窗口”三条命令等 GPT 的窗口接口落地后再接；
 * 在那之前，只有浏览器预览里点纸会换回书本页面，拖动在预览里挪的是假桌面上的框。
 */
export function MiniApp({ bridge, fake }: { bridge: AppBridge; fake: FakeBridge | null }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  useEffect(() => connectBridge(bridge, setSnapshot, () => setSnapshot(null)), [bridge])
  if (!snapshot) return null

  const mini = (
    <MiniCompanion snapshot={snapshot} onExpand={() => { if (fake) openBookPreview() }} onHover={() => {}}
      onMove={(dx, dy) => { if (fake) movePreviewFrame(dx, dy) }} />
  )
  if (!fake) return mini
  return (
    <div className="mini-desktop">
      <div className="mini-desktop-app" aria-hidden />
      <div className="mini-frame">{mini}</div>
      <ScenarioSwitcher fake={fake} />
    </div>
  )
}

function movePreviewFrame(dx: number, dy: number) {
  const frame = document.querySelector<HTMLElement>('.mini-frame')
  if (!frame) return
  const box = frame.getBoundingClientRect()
  frame.style.left = `${box.left + dx}px`
  frame.style.top = `${box.top + dy}px`
  frame.style.right = 'auto'
  frame.style.bottom = 'auto'
}

function openBookPreview() {
  const url = new URL(location.href)
  url.searchParams.delete('view')
  location.assign(url)
}

import { useEffect, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { connectBridge } from '../app/connect-bridge'
import { sendCommand } from '../book/command'
import { ScenarioSwitcher } from '../dev/ScenarioSwitcher'
import type { FakeBridge } from '../dev/fake-bridge'
import { MiniCompanion } from './MiniCompanion'

/**
 * 迷你窗的根：主进程用 ?view=mini 载入同一套渲染代码，走同一个 bridge。
 * 点纸发 window.book 回到书本；悬停发 window.mini.hover，主进程据此切换点穿；拖动发 window.mini.move，主进程夹住坐标并记住位置。
 * 浏览器预览没有真窗口：点纸换回书本页面，拖动挪的是假桌面上的框。
 */
export function MiniApp({ bridge, fake }: { bridge: AppBridge; fake: FakeBridge | null }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  useEffect(() => connectBridge(bridge, setSnapshot, () => setSnapshot(null)), [bridge])
  if (!snapshot) return null

  const send = (body: Parameters<typeof sendCommand>[2]) => { void sendCommand(bridge, snapshot.epoch, body) }
  const mini = fake
    ? <MiniCompanion snapshot={snapshot} onExpand={openBookPreview} onHover={() => {}} onMove={movePreviewFrame} />
    : (
      <MiniCompanion snapshot={snapshot} onExpand={() => send({ type: 'window.book' })}
        onHover={(over) => send({ type: 'window.mini.hover', over })}
        onMove={(dx, dy) => send({ type: 'window.mini.move', dx: Math.round(dx), dy: Math.round(dy) })} />
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

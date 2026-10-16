import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { connectBridge } from '../app/connect-bridge'
import { sendCommand } from '../book/command'
import { ScenarioSwitcher } from '../dev/ScenarioSwitcher'
import type { FakeBridge } from '../dev/fake-bridge'
import { MiniCompanion } from './MiniCompanion'

/**
 * 迷你窗的根：主进程用 ?view=mini 载入同一套渲染代码，走同一个 bridge。
 * 点纸发 window.expand 回到书本；悬停发 window.mini.hover，主进程据此切换点穿；
 * 拖动发 window.mini.moveBy，单位是屏幕物理像素（CSS 位移乘 devicePixelRatio，不足一像素的余量留给下一帧），
 * 主进程按显示器缩放换算、夹在当前屏幕的工作区里并记住位置（docs/engineering/mini-window-contract.md）。
 * 浏览器预览没有真窗口：点纸换回书本页面，拖动挪的是假桌面上的框。
 */
export function MiniApp({ bridge, fake }: { bridge: AppBridge; fake: FakeBridge | null }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const remainder = useRef({ x: 0, y: 0 })
  useEffect(() => connectBridge(bridge, setSnapshot, () => setSnapshot(null)), [bridge])
  const send = useCallback((body: Parameters<typeof sendCommand>[2]) => { void bridge.getSnapshot().then((current) => sendCommand(bridge, current.epoch, body)).catch(() => {}) }, [bridge])
  useEffect(() => {
    if (fake) return
    const released = (event: PointerEvent) => send({ type: 'window.mini.hover', over: !!document.elementFromPoint(event.clientX, event.clientY)?.closest('.mini-paper') })
    window.addEventListener('pointerup', released); window.addEventListener('pointercancel', released)
    return () => { window.removeEventListener('pointerup', released); window.removeEventListener('pointercancel', released) }
  }, [send, fake])
  if (!snapshot) return null

  const mini = fake
    ? <MiniCompanion snapshot={snapshot} onExpand={openBookPreview} onHover={() => {}} onMove={movePreviewFrame} />
    : (
      <MiniCompanion snapshot={snapshot} onExpand={() => send({ type: 'window.expand' })}
        onHover={(over) => send({ type: 'window.mini.hover', over })}
        onMove={(dx, dy) => {
          const ratio = window.devicePixelRatio || 1
          const x = dx * ratio + remainder.current.x
          const y = dy * ratio + remainder.current.y
          const px = Math.max(-10_000, Math.min(10_000, Math.trunc(x)))
          const py = Math.max(-10_000, Math.min(10_000, Math.trunc(y)))
          remainder.current = { x: x - px, y: y - py }
          if (px || py) send({ type: 'window.mini.moveBy', dx: px, dy: py })
        }} />
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

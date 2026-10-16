import { useEffect, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { connectBridge } from '../app/connect-bridge'
import { ScenarioSwitcher } from '../dev/ScenarioSwitcher'
import type { FakeBridge } from '../dev/fake-bridge'
import { MiniCompanion } from './MiniCompanion'

/**
 * 迷你窗的根：主进程用 ?view=mini 载入同一套渲染代码，走同一个 bridge。
 * 原生窗口命令走同一条受限 bridge，主进程辨别实际发送窗口；预览保留假桌面的交互。
 */
export function MiniApp({ bridge, fake }: { bridge: AppBridge; fake: FakeBridge | null }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  useEffect(() => connectBridge(bridge, setSnapshot, () => setSnapshot(null)), [bridge])
  const send = (body: Record<string, unknown>) => { void bridge.getSnapshot().then((snapshot) => bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as import('../../../shared').AppCommand)).catch(() => {}) }
  useEffect(() => {
    if (fake) return
    const released = (event: PointerEvent) => send({ type: 'window.mini.hover', over: !!document.elementFromPoint(event.clientX, event.clientY)?.closest('.mini-paper') })
    window.addEventListener('pointerup', released); window.addEventListener('pointercancel', released)
    return () => { window.removeEventListener('pointerup', released); window.removeEventListener('pointercancel', released) }
  }, [bridge, fake])
  if (!snapshot) return null

  const mini = (
    <MiniCompanion snapshot={snapshot} onExpand={() => { if (fake) openBookPreview(); else send({ type: 'window.book' }) }} onHover={(over) => { if (!fake) send({ type: 'window.mini.hover', over }) }}
      onMove={(dx, dy) => { if (fake) movePreviewFrame(dx, dy); else send({ type: 'window.mini.move', dx: Math.round(dx), dy: Math.round(dy) }) }} />
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

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { sceneSrc } from '../book/Character'
import { DEFAULT_FURNITURE, FURNITURE, type Furniture } from '../book/wash/furniture'
import { TRACE } from '../book/wash/intro'
import { WashRenderer, type Layer } from '../book/wash/renderer'
import type { PathPoint } from '../book/wash/strokes'
import './trace.css'

/**
 * 描图工具（只在浏览器预览里，?trace）：新手流程第 1 步“铅笔画出房间、再勾出她”的路径，由你沿线稿亲手描一遍；
 * 点家具上色用的家具形状，也在这里逐点调整。保存后写进 src/renderer/src/book/wash/paths/，新手流程直接改用。
 * 铅笔是你的：描下来的节奏和压力就是新手流程里那支铅笔的动作。
 */

type Mode = 'room' | 'her' | 'furniture'
const POSE = 'desk-writing_calm'
const MODES: readonly { id: Mode; label: string; hint: string }[] = [
  { id: 'room', label: '描房间线条', hint: '沿着空房间的铅笔线描：窗、书、杯子、桌椅。按下画、抬起换下一笔；数位笔的压力会记下来。' },
  { id: 'her', label: '描她的线条', hint: '沿着她的线稿描：头发、脸、衣服、手。房间的线已经画好了，这一步只描她。' },
  { id: 'furniture', label: '家具形状', hint: '左边选一件，在图上点出它的轮廓；拖动圆点调整，按住 Alt 点圆点删掉。' },
]

export function TraceTool() {
  const [mode, setMode] = useState<Mode>('room')
  const [paths, setPaths] = useState<Record<'room' | 'her', PathPoint[]>>({ room: TRACE?.room ?? [], her: TRACE?.her ?? [] })
  const [items, setItems] = useState<Furniture[]>(() => FURNITURE.map((f) => ({ ...f, points: [...f.points] })))
  const [selected, setSelected] = useState(items[0]?.id ?? '')
  const [status, setStatus] = useState('')
  const current = MODES.find((m) => m.id === mode)!

  async function save() {
    setStatus('正在保存……')
    const files = mode === 'furniture'
      ? [{ file: 'furniture.json', data: { version: 1, items: items.filter((f) => f.points.length >= 3) } }]
      : [{ file: 'trace.json', data: { version: 1, room: paths.room, her: paths.her } }]
    try {
      for (const body of files) {
        const response = await fetch('/__lca/save-trace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        if (!response.ok) throw new Error(String(response.status))
      }
      setStatus('保存好了。打开新手流程看看：?onboarding')
    } catch {
      setStatus('没保存上：请用 pnpm preview:ui 打开这一页（只有预览服务器能写文件）。')
    }
  }

  return (
    <div className="trace">
      <aside className="trace-panel">
        <h1>描图</h1>
        <nav className="trace-modes">
          {MODES.map((m) => <button key={m.id} type="button" data-active={m.id === mode} onClick={() => setMode(m.id)}>{m.label}</button>)}
        </nav>
        <p className="trace-hint">{current.hint}</p>
        {mode !== 'furniture' && (
          <>
            <p className="trace-count">已经描了 {strokeCount(paths[mode])} 笔</p>
            <div className="trace-actions">
              <button type="button" onClick={() => setPaths((all) => ({ ...all, [mode]: dropLastStroke(all[mode]) }))}>撤销一笔</button>
              <button type="button" onClick={() => setPaths((all) => ({ ...all, [mode]: [] }))}>清空</button>
            </div>
          </>
        )}
        {mode === 'furniture' && (
          <>
            <ul className="trace-items">
              {items.map((f) => (
                <li key={f.id}>
                  <button type="button" data-active={f.id === selected} onClick={() => setSelected(f.id)}>{f.name}<small>{f.points.length} 个点</small></button>
                </li>
              ))}
            </ul>
            <div className="trace-actions">
              <button type="button" onClick={() => setItems((list) => list.map((f) => f.id === selected ? { ...f, points: [] } : f))}>清空这件</button>
              <button type="button" onClick={() => setItems((list) => list.map((f) => f.id === selected ? { ...(DEFAULT_FURNITURE.find((d) => d.id === f.id) ?? f) } : f))}>恢复默认</button>
            </div>
          </>
        )}
        <div className="trace-actions">
          <button type="button" className="trace-save" onClick={() => { void save() }}>保存</button>
          <a href="?onboarding&scenario=morning-idle">打开新手流程</a>
        </div>
        {status && <p className="trace-status" role="status">{status}</p>}
      </aside>
      <main className="trace-stage">
        <div className="trace-sheet">
          <TraceBackdrop source={mode === 'room' ? 'empty' : POSE} pencilOnly={mode !== 'furniture'} />
          {mode === 'furniture'
            ? <FurnitureEditor items={items} selected={selected} onChange={setItems} />
            : <TracePad key={mode} points={paths[mode]} onChange={(next) => setPaths((all) => ({ ...all, [mode]: next }))} />}
        </div>
      </main>
    </div>
  )
}

/** 底图：描线时只显示铅笔层（和新手流程里揭开的是同一层），调家具时显示彩图 */
function TraceBackdrop({ source, pencilOnly }: { source: string; pencilOnly: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const canvas = ref.current
    const src = sceneSrc(source)
    if (!canvas || !src) return
    const renderer = WashRenderer.create(canvas)
    if (!renderer) return
    let alive = true
    renderer.resize(1024, 1024)
    renderer.layer(src).then((layer: Layer) => {
      if (!alive) return
      if (pencilOnly) { renderer.resetReveal(1, 1, 0, 1); renderer.draw({ current: layer, previousAlpha: 0, paint: { dry: 1 } }) }
      else renderer.draw({ current: layer, previousAlpha: 0 })
    }, () => {})
    return () => { alive = false; renderer.dispose() }
  }, [source, pencilOnly])
  return <canvas ref={ref} className="trace-backdrop" aria-hidden />
}

/** 描线：按下开始一笔（第一点是抬笔移过去），移动记下压力和时间，抬起结束 */
function TracePad({ points, onChange }: { points: PathPoint[]; onChange: (points: PathPoint[]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const live = useRef<PathPoint[] | null>(null)
  const origin = useRef<number | null>(null)

  useEffect(() => { draw(ref.current, points) }, [points])

  // 时间接着已有路径往后记：中间的空档到新手流程里会压短
  const at = (canvas: HTMLCanvasElement, sample: { clientX: number; clientY: number; pressure: number; pointerType: string }, down: boolean): PathPoint => {
    const box = canvas.getBoundingClientRect()
    if (origin.current === null) origin.current = performance.now() - (points.at(-1)?.t ?? 0) - 400
    return {
      x: clamp01((sample.clientX - box.left) / box.width),
      y: clamp01((sample.clientY - box.top) / box.height),
      t: Math.round(performance.now() - origin.current),
      down,
      p: sample.pointerType === 'pen' ? Math.round(sample.pressure * 100) / 100 : 0.5,
    }
  }

  return (
    <canvas ref={ref} className="trace-pad" width={1024} height={1024}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        live.current = [...points, at(event.currentTarget, event, false)]
      }}
      onPointerMove={(event) => {
        if (!live.current) return
        const native = event.nativeEvent
        const samples = native.getCoalescedEvents?.().length ? native.getCoalescedEvents() : [native]
        for (const sample of samples) {
          const p = at(event.currentTarget, sample, true)
          const last = live.current.at(-1)!
          if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.0015) live.current.push(p)
        }
        draw(ref.current, live.current)
      }}
      onPointerUp={() => { if (live.current) { onChange(live.current); live.current = null } }}
      onPointerCancel={() => { live.current = null; draw(ref.current, points) }}
    />
  )
}

function draw(canvas: HTMLCanvasElement | null, points: readonly PathPoint[]) {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgb(185 112 88 / 0.85)'
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (!b.down) continue
    ctx.lineWidth = 2 + 5 * (b.p ?? 0.5)
    ctx.beginPath()
    ctx.moveTo(a.x * canvas.width, a.y * canvas.height)
    ctx.lineTo(b.x * canvas.width, b.y * canvas.height)
    ctx.stroke()
  }
}

/** 家具形状：点图加点，拖圆点挪，Alt＋点圆点删 */
function FurnitureEditor({ items, selected, onChange }: { items: Furniture[]; selected: string; onChange: (items: Furniture[]) => void }) {
  const svg = useRef<SVGSVGElement>(null)
  const dragging = useRef<{ id: string; index: number } | null>(null)
  const toUv = (event: { clientX: number; clientY: number }): [number, number] => {
    const box = svg.current!.getBoundingClientRect()
    return [round3(clamp01((event.clientX - box.left) / box.width)), round3(clamp01((event.clientY - box.top) / box.height))]
  }
  const update = (id: string, points: (readonly [number, number])[]) => onChange(items.map((f) => (f.id === id ? { ...f, points } : f)))

  return (
    <svg ref={svg} className="trace-furniture" viewBox="0 0 1 1" preserveAspectRatio="none"
      onPointerDown={(event) => {
        if (event.target !== svg.current && !(event.target as Element).classList.contains('trace-shape')) return
        const item = items.find((f) => f.id === selected)
        if (item) update(item.id, [...item.points, toUv(event)])
      }}
      onPointerMove={(event) => {
        const d = dragging.current
        if (!d) return
        const item = items.find((f) => f.id === d.id)
        if (item) update(item.id, item.points.map((p, i) => (i === d.index ? toUv(event) : p)))
      }}
      onPointerUp={() => { dragging.current = null }}>
      {items.map((f) => (
        <g key={f.id} data-active={f.id === selected}>
          <polygon className="trace-shape" points={f.points.map((p) => p.join(',')).join(' ')} />
          {f.id === selected && f.points.map(([x, y], index) => (
            <circle key={index} className="trace-vertex" cx={x} cy={y} r={0.009}
              onPointerDown={(event) => {
                event.stopPropagation()
                if (event.altKey) { update(f.id, f.points.filter((_, i) => i !== index)); return }
                event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
                dragging.current = { id: f.id, index }
              }} />
          ))}
        </g>
      ))}
    </svg>
  )
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const round3 = (v: number) => Math.round(v * 1000) / 1000
const strokeCount = (points: readonly PathPoint[]) => points.filter((p) => !p.down).length
function dropLastStroke(points: readonly PathPoint[]): PathPoint[] {
  const start = points.findLastIndex((p) => !p.down)
  return start < 0 ? [] : points.slice(0, start)
}

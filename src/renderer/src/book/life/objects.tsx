import type { GiftMotif, GiftObjectId } from '../../../../shared'
import { QuillArt } from '../quill/QuillArt'

export type ObjectKind = GiftObjectId

/**
 * 小物件的手绘：她带回来的贝壳、叶子，和礼物架上还没有 3D 模型时的样子。
 * 和羽毛笔同一支深色描边、淡彩填色（美术规格 §2.5）；新出现时先画线、再上色（体验设计 §3“刚回来”）。
 * viewBox 都是 40×34，底边是物件落在桌面／窗台上的地方。
 */
const SKETCH: Record<Exclude<ObjectKind, 'quill'>, { fill: string; shapes: string[]; lines: string[] }> = {
  shell: {
    fill: '#f6d9c9',
    shapes: ['M20 30 L6 15 Q4.5 10.5 8 8.5 Q10.5 4.8 14.2 5.6 Q17 2.6 20 3.4 Q23 2.6 25.8 5.6 Q29.5 4.8 32 8.5 Q35.5 10.5 34 15 Z', 'M15.5 29 L13.8 32.6 L26.2 32.6 L24.5 29 Z'],
    lines: ['M20 30 L9 9.4', 'M20 30 L13.6 6.4', 'M20 30 L20 4', 'M20 30 L26.4 6.4', 'M20 30 L31 9.4'],
  },
  leaf: {
    fill: '#e8c57e',
    shapes: ['M7 28 C 8.5 16.5, 18.5 6.5, 34.5 5 C 33.5 18.5, 24 28, 7 28 Z'],
    lines: ['M3 32.5 L7 28 Q 20 18.5 33.4 6.2', 'M14 21.4 L13.2 15.6', 'M19 17.6 L18.8 11.2', 'M24.4 13.4 L24.8 8.4', 'M14 21.4 L20.4 22.6', 'M19 17.6 L26.2 18.2', 'M24.4 13.4 L30.2 13'],
  },
  cup: {
    fill: '#f7efe6',
    shapes: ['M9 8.5 L11 29.5 Q20 32.5 29 29.5 L31 8.5 Q20 12.5 9 8.5 Z', 'M31 12.5 Q37.8 12.5 37.2 18.6 Q36.6 24.6 30.2 24'],
    lines: ['M9 8.5 Q20 4.5 31 8.5'],
  },
  'paper-bridge': {
    fill: '#fbf3e4',
    shapes: ['M3 27 L37 27 L37 22.5 Q20 6.5 3 22.5 Z'],
    lines: ['M10 27 Q20 15.5 30 27', 'M3 22.5 L3 27', 'M20 14.6 L20 18.6'],
  },
}

/** 礼物的花样（共享枚举）：画在物件身上的几处小樱花或小星星 */
const MOTIF_SPOTS: Record<Exclude<ObjectKind, 'quill'>, readonly [number, number][]> = {
  cup: [[15.5, 17], [22, 21.5], [17.5, 26]],
  'paper-bridge': [[7.5, 24.6], [32.5, 24.6], [20, 21.2]],
  leaf: [[16, 20], [23.5, 13.5]],
  shell: [[13.5, 13.5], [26.5, 13.5], [20, 21]],
}

function Sakura({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} fill="#f2b8c6" stroke="#c98593" strokeWidth="0.25">
      {[0, 72, 144, 216, 288].map((angle) => <ellipse key={angle} cx="0" cy="-1.25" rx="0.85" ry="1.15" transform={`rotate(${angle})`} />)}
      <circle r="0.45" fill="#e3c785" stroke="none" />
    </g>
  )
}
function Star({ x, y }: { x: number; y: number }) {
  return <path transform={`translate(${x} ${y})`} fill="#e3c785" stroke="#9c7c3c" strokeWidth="0.25" strokeLinejoin="round"
    d="M0 -2 L0.6 -0.6 L2 0 L0.6 0.6 L0 2 L-0.6 0.6 L-2 0 L-0.6 -0.6 Z" />
}

export function ObjectSketch({ kind, className, drawing = false, motif = 'plain' }: { kind: ObjectKind; className?: string; drawing?: boolean; motif?: GiftMotif }) {
  if (kind === 'quill') return <QuillArt className={className} />
  const art = SKETCH[kind]
  return (
    <svg className={className} viewBox="0 0 40 34" data-drawing={drawing} aria-hidden>
      <g fill="none" stroke="#4d3f45" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        {art.shapes.map((d) => <path key={d} className="sketch-shape" pathLength={1} fill={art.fill} d={d} />)}
        {art.lines.map((d) => <path key={d} className="sketch-line" pathLength={1} strokeWidth="0.8" opacity="0.7" d={d} />)}
      </g>
      {motif !== 'plain' && <g className="sketch-motif">{MOTIF_SPOTS[kind].map(([x, y]) => motif === 'sakura' ? <Sakura key={`${x},${y}`} x={x} y={y} /> : <Star key={`${x},${y}`} x={x} y={y} />)}</g>}
    </svg>
  )
}

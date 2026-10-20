/**
 * 左页上色的“活”：新手流程每一步要画什么、点一件家具画什么、恢复存档和换姿势时怎么重画。
 * 都是一笔一笔画（painter.ts）：铅笔揭开线稿，羽毛笔顺着笔触上色，最后收干补满。纯函数，单测直接引用。
 *
 * 2026-10-16 用户看过“从中间一点往外扩”的晕染，觉得不美观、不像绘画；这里不再用单点扩散。
 */
import type { Furniture } from './furniture'
import type { Job } from './painter'
import { brushStrokes, scribble, tracedStroke, type PathPoint, type Region, type StampStyle } from './strokes'

export type IntroStep = 'paper' | 'drawing' | 'flat' | 'real' | 'room' | 'done'
export const INTRO_ORDER: readonly IntroStep[] = ['paper', 'drawing', 'flat', 'real', 'room', 'done']

export const ROOM_DRAW_MS = 6500
export const HER_DRAW_MS = 2800
const PENCIL_FILL_MS = 600
const FLAT_MS = 1700
const REAL_MS = 1900
const PAINT_FILL_MS = 400
const FURNITURE_MS = 1300
const ROOM_PAINT_MS = 4800
const ROOM_FILL_MS = 800
const POSE_MS = 900
/** 她回来：先出线稿，再比平常换姿势慢一点地上色 */
export const ARRIVE_MS = 1700
/** 整屋上色从开始到收干的时间（新手流程据此转到“她注意到你”） */
export const ROOM_COLOR_MS = ROOM_PAINT_MS + ROOM_FILL_MS + 900

const PENCIL_AUTO: StampStyle = { radius: 0.075, strength: 1, aspect: 1, ragged: 0 }
const PENCIL_TRACED: StampStyle = { radius: 0.011, strength: 1, aspect: 1, ragged: 0, pressure: true }
/** 颜料笔刷：沿笔画方向拉长、毛边、每个印章只有一层薄色，叠几遍才饱和 */
const brush = (radius: number): StampStyle => ({ radius, strength: 0.16, aspect: 1.7, ragged: 0.4 })

/** 整个房间：斜着来回刷，从中间那一笔往两边铺 */
export const ROOM_REGION: Region = { cx: 0.5, cy: 0.5, angle: -0.35, halfLength: 0.64, halfWidth: 0.52 }
/** 她坐在画面右半：没有剪影时（素材缺失等）用这个范围 */
export const HER_FALLBACK: Region = { cx: 0.68, cy: 0.53, angle: 1.45, halfLength: 0.4, halfWidth: 0.24 }

interface TraceFile { version: 1; room: PathPoint[]; her: PathPoint[] }
const traces = import.meta.glob<TraceFile>('./paths/trace.json', { eager: true, import: 'default' })
/** 用户在描图工具里手描的路径（?trace 保存）；没有就用自动排线 */
export const TRACE: TraceFile | undefined = traces['./paths/trace.json']

/** 进入新手流程的某一步时要排上的活；之前的步骤由调用方保证已经排过 */
export function introJobs(step: IntroStep, her: Region | null, trace: TraceFile | undefined = TRACE): Job[] {
  const region = her ?? HER_FALLBACK
  switch (step) {
    case 'drawing': {
      const room = trace?.room.length ? tracedStroke(trace.room, ROOM_DRAW_MS) : scribble({ x0: 0.04, y0: 0.06, x1: 0.96, y1: 0.94 }, 9, ROOM_DRAW_MS, 3)
      const herLines = trace?.her.length ? tracedStroke(trace.her, HER_DRAW_MS) : scribble({ x0: 0.42, y0: 0.13, x1: 0.94, y1: 0.93 }, 6, HER_DRAW_MS, 7)
      const style = trace ? PENCIL_TRACED : PENCIL_AUTO
      return [
        { id: 'intro:room', stroke: room, style, channel: 'room', blend: 'max', mask: { kind: 'none' }, cursor: 'pencil', fillMs: PENCIL_FILL_MS },
        { id: 'intro:her', stroke: herLines, style, channel: 'her', blend: 'max', mask: { kind: 'none' }, cursor: 'pencil', fillMs: PENCIL_FILL_MS },
      ]
    }
    case 'flat': {
      const { stroke, radius } = brushStrokes(region, 7, FLAT_MS, 11, 'outward')
      return [{ id: 'intro:flat', stroke, style: brush(radius), channel: 'paint', blend: 'add', mask: { kind: 'her' }, cursor: 'quill', fillMs: PAINT_FILL_MS }]
    }
    case 'real': {
      const { stroke, radius } = brushStrokes(region, 6, REAL_MS, 13, 'outward')
      return [{ id: 'intro:real', stroke, style: brush(radius), channel: 'real', blend: 'add', mask: { kind: 'her' }, cursor: 'quill', fillMs: PAINT_FILL_MS }]
    }
    case 'room': return [roomJob('intro:room-color', 'paint+real')]
    default: return []
  }
}

/**
 * 你在家具上涂的彩铅：比她的颜料笔小、色更实，带一点毛边；只上简单的颜色，真实颜色留给她。
 * 涂到这件家具的四成多，她就拿羽毛笔接过去（2026-10-20 用户：点一下就自动上色，起不到指引作用）。
 */
export const USER_PENCIL: StampStyle = { radius: 0.024, strength: 0.5, aspect: 1.3, ragged: 0.55 }
export const COVERED_ENOUGH = 0.42

/** 点一件家具：在它的形状里顺着长边刷几笔，再补满 */
export function furnitureJob(item: Furniture, region: Region): Job {
  const count = Math.max(2, Math.min(6, Math.round(region.halfWidth / 0.03)))
  const { stroke, radius } = brushStrokes(region, count, FURNITURE_MS, hash(item.id))
  return { id: `furniture:${item.id}`, stroke, style: brush(radius), channel: 'paint+real', blend: 'add', mask: { kind: 'polygon', id: item.id, points: item.points }, cursor: 'quill', fillMs: PAINT_FILL_MS }
}

/** 存档恢复：羽毛笔把整个房间重新画一遍 */
export function restoreJob(): Job {
  return roomJob('restore', 'paint')
}

/** 换姿势：房间不动，只把她重画一遍，不出现笔；她回来时多画两笔、慢一点 */
export function poseJob(her: Region, durationMs = POSE_MS): Job {
  const slow = durationMs > POSE_MS
  const { stroke, radius } = brushStrokes(her, slow ? 6 : 4, durationMs, 17)
  return { id: 'pose', stroke, style: brush(radius), channel: 'paint', blend: 'add', mask: { kind: 'her' }, cursor: null, fillMs: slow ? 500 : 300 }
}

function roomJob(id: string, channel: 'paint' | 'paint+real'): Job {
  const { stroke, radius } = brushStrokes(ROOM_REGION, 8, ROOM_PAINT_MS, 5, 'outward')
  return { id, stroke, style: brush(radius), channel, blend: 'add', mask: { kind: 'none' }, cursor: 'quill', fillMs: ROOM_FILL_MS }
}

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

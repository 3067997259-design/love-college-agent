import { FURNITURE } from '@wash/furniture'
import { HER_FALLBACK, introJobs, ROOM_REGION } from '@wash/intro'
import type { Job } from '@wash/painter'
import { brushStrokes, regionOf, type Region, type StampStyle } from '@wash/strokes'
import { cameraAt, clamp, easeInOut, Events, lerp, span, track } from './anim'
import type { Assets, Cut } from './cut'
import { Brushes, chain, Engine, rect, rotate, scale, translate, view, type Img } from './engine'
import { PENCIL_TIP, pencilCanvas } from './sprites'

/**
 * 开场片（路演剪辑版，分镜表 §5）：约 22.5 秒。
 *  0.0– 8.0 无音乐。02 铅笔在空白页上画出房间，再勾出她（应用新手流程的铅笔，同一套笔触）
 *  8.0      歌曲 0:31.25 进来。03 颜色从她本子上的字迹开始，往书桌、窗、整间屋子铺开；窗户上完色后过一夜
 * 15.5      0:38.8「何を知ろうとも」04 她转过来看你，镜头推近；0:41.5 她笑了
 * 19.2      07 拉出到整本书；20.44 = 0:43.689「手を繋いだ」，计划卡越过中缝来到右页；停在这一帧，切到现场
 * 时刻都写在这里，改剪辑点只改这几个数（歌曲时刻 = 片子时刻 − 8 + 31.25）。
 */

const WRITING_PAINT = 8.25
const TURN = 15.55
const SMILE = 18.25
const PULL = 19.2
const CROSS = 20.44

export async function opening(engine: Engine, assets: Assets): Promise<Cut> {
  const load = (id: string) => engine.image(assets.url(assets.art[id]))
  const [writing, night, calm, smile, empty] = await Promise.all(['desk-writing', 'desk-writing-night', 'facing-user', 'facing-user-smile', 'empty'].map(load))
  const spread = await engine.sprite(assets.url('film/out/plates/spread-opening.png'))
  const card = await engine.sprite(assets.url('film/out/plates/card.png'))
  const pencil = await engine.sprite(await pencilCanvas())
  const { room, card: cardBox } = assets.layout

  const reveal = engine.target(1024, 1024)
  engine.clear(reveal, 0, 0, 0, 0)
  const plates = [engine.target(writing.width, writing.height), engine.target(writing.width, writing.height)]
  const her = engine.herMask(writing, empty)
  const herRegion: Region = her.region ?? HER_FALLBACK
  const brushes = new Brushes(engine, reveal, (job) => job.mask.kind === 'polygon' ? engine.polygonMask(job.mask.id, job.mask.points)
    : job.mask.kind === 'her' ? her.texture : null)

  const events = new Events()
  // 02：铅笔先画空房间，再勾出她
  events.at(0.5, () => { for (const job of introJobs('drawing', her.region)) brushes.lane(0).enqueue(job) })
  // 03：颜色从本子上的字迹开始，三处同时往外铺，最后整间屋子收齐
  events.at(WRITING_PAINT, () => { for (const job of [item('notebook', 800), herJob(herRegion), item('desk', 1200), item('chair', 800)]) brushes.lane(1).enqueue(job) })
  events.at(WRITING_PAINT + 0.85, () => { for (const job of [item('note', 700), item('mug', 700), item('books', 800), item('lamp', 700), item('plant', 800)]) brushes.lane(2).enqueue(job) })
  events.at(WRITING_PAINT + 2.1, () => { for (const job of [item('window', 1500), item('curtain', 800), item('curtain-right', 800)]) brushes.lane(3).enqueue(job) })
  events.at(WRITING_PAINT + 4.9, () => brushes.lane(4).enqueue(wholeRoom()))

  // 房间这几镜的画：窗户上完色以后过一夜（同一姿势的夜景，铅笔线仍用白天那张，免得没上色的纸面发灰）→ 转过来 → 笑
  const nightLit: Img = { ...night, pencil: writing.pencil }
  const scenes: [number, Img][] = [[0, writing], [12.9, nightLit], [14.3, writing], [TURN, calm], [SMILE, smile]]
  const FADE = 0.7

  const R = { cx: room.x + room.width / 2, cy: room.y + room.height / 2 }
  const at = (u: number, v: number) => ({ x: room.x + u * room.width, y: room.y + v * room.height })
  const fill = (k: number) => 1080 / room.height * k
  const face = at(0.6, 0.36)
  const shots = [
    [0, { x: R.cx, y: R.cy, zoom: fill(0.95) }],
    [7.5, { ...at(0.56, 0.52), zoom: fill(1.08) }],
    [TURN, { ...at(0.58, 0.52), zoom: fill(1.22) }],
    [PULL - 0.3, { ...face, zoom: fill(1.7) }],
    [CROSS - 0.15, { x: 960, y: 540, zoom: 1 }],
  ] as const

  let pencilAlpha = 0
  let last = 0
  return {
    duration: 22.55,
    frame(t) {
      events.advance(t)
      const { cursor, dry } = brushes.step(t * 1000)
      const dt = t - last
      last = t
      const camera = cameraAt(shots, t)
      const v = view(camera)
      engine.begin()

      // 拉出时整本书淡进来（书页纸色和打底的纸色几乎一样，只多出封皮和中缝）；右页的字进画面之前就要淡完，不然会叠影
      const book = track([[PULL - 0.05, 0], [PULL + 0.25, 1]], t)
      if (book > 0) engine.place(spread.texture, chain(v, rect(0, 0, 1920, 1080)), { alpha: book })

      // 房间：当前这张，交替时上面叠下一张
      let index = 0
      while (index + 1 < scenes.length && t >= scenes[index + 1][0]) index++
      const fading = index + 1 < scenes.length ? span(t, scenes[index + 1][0] - FADE, scenes[index + 1][0]) : 0
      const draw = (image: Img, plate: number, alpha: number) => {
        engine.appPlate(plates[plate], { current: image, reveal, paint: { dry }, intro: { empty } })
        engine.place(plates[plate].texture, chain(v, rect(room.x, room.y, room.width, room.height)), { flip: true, alpha })
      }
      draw(scenes[index][1], 0, 1)
      if (fading > 0) draw(scenes[index + 1][1], 1, easeInOut(fading))

      // 你手里的铅笔：画的时候出现，抬笔时略离开纸面
      const showPencil = cursor?.kind === 'pencil'
      pencilAlpha = clamp(pencilAlpha + (showPencil ? 1 : -1) * dt / 0.24)
      if (pencilAlpha > 0 && cursor) {
        const size = room.width * 0.123
        const lift = cursor.down ? [0, 0] : [room.width * 0.008, -room.width * 0.012]
        const tip = at(cursor.x, cursor.y)
        engine.place(pencil.texture, chain(v, translate(tip.x + lift[0], tip.y + lift[1]), scale(size), translate(-PENCIL_TIP[0], -PENCIL_TIP[1])), { alpha: pencilAlpha })
      }

      // 07：她推过来的那张纸，0:43.689 正好越过中缝
      const fly = span(t, CROSS - 0.5, CROSS + 0.46)
      if (fly > 0) {
        const e = easeInOut(fly)
        const end = { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 }
        const start = at(0.6, 0.86)
        const x = lerp(start.x, end.x, e)
        const y = lerp(start.y, end.y, e) - Math.sin(Math.PI * e) * 40
        const s = lerp(0.62, 1, e)
        const angle = lerp(-0.13, 0, e)
        engine.place(card.texture, chain(v, translate(x, y), rotate(angle), scale(s), translate(-cardBox.width / 2, -cardBox.height / 2), rect(0, 0, cardBox.width, cardBox.height)),
          { alpha: track([[0, 0], [0.2, 1]], fly) })
      }
    },
  }
}

/** 颜料笔刷（和 intro.ts 同样的参数：拉长、毛边、薄薄一层） */
const brush = (radius: number): StampStyle => ({ radius, strength: 0.16, aspect: 1.7, ragged: 0.4 })

/** 一件家具：顺着长边刷几笔再补满；她在写字，颜色自己从字迹里漫出来，所以不出现笔 */
function item(id: string, durationMs: number): Job {
  const f = FURNITURE.find((entry) => entry.id === id)
  if (!f) throw new Error(`没有这件家具：${id}`)
  const region = regionOf(f.points)
  const count = Math.max(2, Math.min(6, Math.round(region.halfWidth / 0.03)))
  const { stroke, radius } = brushStrokes(region, count, durationMs, hash(id))
  return { id, stroke, style: brush(radius), channel: 'paint+real', blend: 'add', mask: { kind: 'polygon', id, points: f.points }, cursor: null, fillMs: 300 }
}

function herJob(region: Region): Job {
  const { stroke, radius } = brushStrokes(region, 7, 1600, 11, 'outward')
  return { id: 'her', stroke, style: brush(radius), channel: 'paint+real', blend: 'add', mask: { kind: 'her' }, cursor: null, fillMs: 350 }
}

function wholeRoom(): Job {
  const { stroke, radius } = brushStrokes(ROOM_REGION, 8, 3000, 5, 'outward')
  return { id: 'room', stroke, style: brush(radius), channel: 'paint+real', blend: 'add', mask: { kind: 'none' }, cursor: null, fillMs: 700 }
}

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

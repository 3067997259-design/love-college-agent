import type { Job } from '@wash/painter'
import { brushStrokes, type Region, type StampStyle } from '@wash/strokes'
import { cameraAt, clamp, easeIn, easeInOut, easeOut, Events, lerp, random, span, track } from './anim'
import type { Assets, Box, Cut } from './cut'
import { Brushes, chain, Engine, rect, rotate, scale, translate, view, type Affine, type Camera, type FilmPlateArgs, type Img, type Sprite, type Target } from './engine'
import { INK, leafCanvas, petalCanvas, QUILL_TIP, quillCanvas } from './sprites'

/**
 * 收尾片（路演剪辑版，分镜表 §5）：约 44 秒，停在最后一帧，主讲接过渡句。
 * 歌曲时刻：t < 19.05 时 = t + 102.95；之后 = t + 116.95（2:02 跳到 2:16，两处都在长间奏里）。
 *  0.0  1:42.95 12 夜里坐在秋千上写日记，侧身不给你看
 *  2.4  1:45.3「遠く流れた」13 写完，抬头笑着看你
 *  4.5  1:47.5「『私じゃない物語』」13 把羽毛笔递过来，你的手接住
 *  9.7  1:52.6 歌词断开，风起。14 她跳下秋千奔向你，花瓣和叶子越来越密
 * 14.0  1:57 全曲最安静的时候，风把颜色连同她一起卷走，只剩白纸
 * 15.0  镜头拉远：白纸是一本书的一页。15 书里的秋千和海岸都没有她了，颜色顺着风流走，剩下线稿
 * 19.05 2:16 17 线一页页淡下去，镜头推进白纸；羽毛笔落下
 * 22.15 2:19.1 副歌第一拍。18 笔尖一滴墨在白纸上晕开，线条从那里长回来，羽毛笔把颜色重新画上：她坐在秋千下
 * 34.0  2:31 19 她拿起日记，扭着头不太敢看你 → 慢慢递过来 → 40.77 = 2:37.7「手を繋いだ」交到你手里，脸红最浓
 * 44.05 停住
 * 时刻都在 T 里，改剪辑点只改这里；用哪张图在 film/cuts.json。
 */

const T = {
  smile: 2.4, quill: 4.5, petals: 8.8, wind: 9.7, sweep: 13.25, gone: 15.0, develop: 15.5, drain: 16.9,
  jump: 19.05, push: 19.4, quillIn: 21.0, touch: 22.15, paint: 24.4, her19: 34.0, offer: 37.6, given: 40.77, end: 44.05,
} as const

/** 画在纸上的样子：颜色在边缘带毛边地褪掉，铅笔线再往外多留一点（和应用左页同一个意思） */
const ON_PAPER = { color: 0.07, lines: 0.018, ragged: 0.6 }
const PLATE_HEIGHT = 1040
/** 关键帧摆在画面中间，四周留一点纸 */
const framed = (image: Img): Box => {
  const width = PLATE_HEIGHT * image.width / image.height
  return { x: 960 - width / 2, y: 540 - PLATE_HEIGHT / 2, width, height: PLATE_HEIGHT }
}
const boxRect = (box: Box) => rect(box.x, box.y, box.width, box.height)
const brush = (radius: number): StampStyle => ({ radius, strength: 0.16, aspect: 1.7, ragged: 0.4 })

export async function closing(engine: Engine, assets: Assets): Promise<Cut> {
  const ids = ['k12', 'k13-smile', 'k13-quill', 'k14', 'swing', 'coast', 'k18', 'k19-turn', 'k19-offer', 'k19-given'] as const
  const loaded = await Promise.all(ids.map((id) => engine.image(assets.url(assets.art[id]))))
  const art = Object.fromEntries(ids.map((id, i) => [id, loaded[i]])) as Record<(typeof ids)[number], Img>
  const book = await engine.sprite(assets.url('film/out/plates/spread-empty.png'))
  const quill = await engine.sprite(await quillCanvas())
  const petal = await engine.sprite(petalCanvas())
  const leaf = await engine.sprite(leafCanvas())
  const { pageLeft, pageRight } = assets.layout

  const wide = [engine.target(1760, 1204, true), engine.target(1760, 1204, true)]
  const tall = [engine.target(822, 1200), engine.target(822, 1200)]

  // 18：线条和颜色重新长出来的揭开遮罩；颜色由羽毛笔一笔一笔画
  const regrow = engine.target(1024, 1024)
  engine.clear(regrow, 0, 0, 0, 0)
  const brushes = new Brushes(engine, regrow, () => null)
  const k18 = framed(art.k18)
  const bloom = { u: 0.6, v: 0.47 }
  const touch = { x: k18.x + bloom.u * k18.width, y: k18.y + bloom.v * k18.height }
  const paintJob = herWorld()
  const paintStart = { x: k18.x + paintJob.stroke.points[0].x * k18.width, y: k18.y + paintJob.stroke.points[0].y * k18.height }
  let paintedAt: number | null = null
  const events = new Events().at(T.paint, () => brushes.lane(0).enqueue(paintJob))

  const wind = makeWind()

  /** 一张关键帧画进目标纹理，按镜头贴进画面 */
  const plate = (target: Target, args: FilmPlateArgs, box: Box, camera: Camera, alpha = 1) => {
    engine.filmPlate(target, args)
    engine.place(target.texture, chain(view(camera), boxRect(box)), { flip: true, alpha })
  }
  const still = (image: Img, t: number): FilmPlateArgs => ({ image, edge: ON_PAPER, lines: 0.55, time: t })

  return {
    duration: T.end,
    frame(t) {
      events.advance(t)
      const { cursor, dry, busy } = brushes.step(t * 1000)
      if (t > T.paint + 0.5 && !busy && paintedAt === null) paintedAt = t
      engine.begin()

      // —— 12–14：秋千那晚，画在纸上 ——
      if (t < T.gone) {
        // 同一晚的几张叠化；递笔的近景到风起的全身构图差太多，先淡回纸面再淡入
        const sequence: Shot[] = [[0, art.k12, 'dissolve', 0.35], [T.smile, art['k13-smile'], 'dissolve', 0.6], [T.quill, art['k13-quill'], 'dissolve', 0.6], [T.wind, art.k14, 'dip', 0.45]]
        const cameras: [number, Camera][] = [
          [0, { x: 960, y: 540, zoom: 1 }], [T.smile, { x: 985, y: 515, zoom: 1.05 }],
          [T.quill - 0.2, { x: 975, y: 520, zoom: 1.04 }], [T.wind - 0.3, { x: 950, y: 590, zoom: 1.13 }],
          [T.wind + 0.3, { x: 960, y: 540, zoom: 1.04 }], [T.sweep, { x: 950, y: 545, zoom: 1.06 }], [T.gone, { x: 930, y: 540, zoom: 0.94 }],
        ]
        const base = cameraAt(cameras, t)
        // 起风以后镜头跟着轻轻晃
        const shake = span(t, T.wind, T.sweep + 0.6) * (1 - span(t, T.sweep + 0.6, T.gone))
        const camera: Camera = { x: base.x + shake * (Math.sin(t * 1.3) * 7 + Math.sin(t * 3.1) * 3), y: base.y + shake * Math.cos(t * 1.7) * 5, zoom: base.zoom, roll: shake * Math.sin(t * 0.9) * 0.006 }
        layers(t, sequence).forEach(({ image, alpha }, i) => {
          const args = still(image, t)
          if (image === art.k14 && t > T.sweep) args.sweep = { front: lerp(-1.0, 1.25, span(t, T.sweep, T.gone - 0.1)), angle: -0.1, width: 0.5, push: 0.7, streak: 1, lines: true }
          plate(wide[i], args, framed(image), camera, alpha)
        })
      }

      // —— 15、17：一本书。秋千和海岸没有她了，颜色流走，线也淡下去 ——
      if (t >= T.gone && t < T.touch) {
        const camera = cameraAt([
          [T.gone, { x: 560, y: 540, zoom: 2.6 }], [T.develop + 1.2, { x: 960, y: 540, zoom: 1 }],
          [T.push, { x: 960, y: 540, zoom: 1 }], [T.quillIn + 0.6, { x: 550, y: 520, zoom: 2.6 }],
        ], t)
        const v = view(camera)
        const bookAlpha = track([[T.gone, 0], [T.gone + 0.5, 1], [T.quillIn, 1], [T.quillIn + 0.6, 0]], t)
        engine.place(book.texture, chain(v, rect(0, 0, 1920, 1080)), { alpha: bookAlpha })
        const develop = track([[T.develop, 0], [T.develop + 0.9, 1]], t)
        const pages: [Img, Box, number, number, number][] = [
          // 图、位置、颜色开始流走的时刻、线开始淡的时刻、线淡完的时刻
          [art.swing, pictureOn(pageLeft, -20), T.drain, T.jump + 0.25, T.push + 1.9],
          [art.coast, pictureOn(pageRight, 20), T.drain + 0.4, T.jump + 0.05, T.push + 1.2],
        ]
        pages.forEach(([image, box, drain, fadeFrom, fadeTo], i) => {
          const args: FilmPlateArgs = {
            image, edge: { color: 0.06, lines: 0.015, ragged: 0.6 }, lines: develop * track([[fadeFrom, 0.75], [fadeTo, 0]], t), color: develop, time: t,
            sweep: { front: lerp(-1.0, 1.2, span(t, drain, drain + 1.7)), angle: 0.05, width: 0.35, push: 0.12, streak: 0.5, lines: false },
          }
          if (t >= fadeTo) return
          engine.filmPlate(wide[i], args)
          engine.place(wide[i].texture, chain(v, boxRect(box)), { flip: true })
        })
      }

      // —— 18：一滴墨晕开，线条长回来，羽毛笔重新上色：她坐在秋千下 ——
      if (t >= T.touch && t < T.her19 + 0.6) {
        if (t < T.paint + 1.2) {
          // 线条从墨滴往外长：一个越来越大的毛边圆，边缘是渐变，线慢慢显出来
          const r = easeOut(span(t, T.touch + 0.15, T.paint + 1.2)) * 2.1
          if (r > 0) engine.stamp(regrow, [bloom.u, bloom.v, r, 1, 0, art.k18.height / art.k18.width], 'room', 'max', 0.5, null)
        }
        const camera = cameraAt([[T.touch, { x: 960, y: 540, zoom: 1 }], [T.paint + 5.6, { x: 960, y: 540, zoom: 1.01 }], [T.her19 + 0.6, { x: 1000, y: 470, zoom: 1.1 }]], t)
        // 墨滴：落下时晕开，线条长回来时被纸吸淡，上色时被颜色盖住
        const inkRadius = track([[T.touch, 0], [T.touch + 0.5, 0.032], [T.touch + 2.0, 0.042]], t, easeOut)
        const inkAlpha = track([[T.touch, 0.9], [T.paint, 0.6], [T.paint + 2.4, 0]], t)
        const args: FilmPlateArgs = {
          image: art.k18, reveal: regrow, edge: ON_PAPER, lines: 0.6, dry, time: t,
          ink: { x: bloom.u, y: bloom.v, radius: inkRadius, alpha: inkAlpha, color: INK },
        }
        const out = span(t, T.her19 - 0.4, T.her19 + 0.4)
        plate(wide[0], args, k18, camera, 1 - easeInOut(out))

        // 羽毛笔：从右上落下，点一滴墨，抬起来去画第一笔，画完离开
        const pose = quillPose(t, touch, paintStart, cursor && { x: k18.x + cursor.x * k18.width, y: k18.y + cursor.y * k18.height, down: cursor.down }, paintedAt)
        if (pose) drawQuill(engine, quill, view(camera), pose)
      } else if (t >= T.quillIn && t < T.touch) {
        const pose = quillPose(t, touch, paintStart, null, null)
        if (pose) drawQuill(engine, quill, view({ x: 960, y: 540, zoom: 1 }), pose)
      }

      // —— 19：拿起日记，不太敢看你，慢慢递过来，交到你手里 ——
      if (t >= T.her19 - 0.4) {
        const camera = cameraAt([[T.her19 - 0.4, { x: 960, y: 520, zoom: 1 }], [T.end, { x: 960, y: 455, zoom: 1.16 }]], t, (x) => x)
        const sequence: Shot[] = [[T.her19 + 0.4, art['k19-turn'], 'dissolve', 0.8], [T.offer, art['k19-offer'], 'dissolve', 0.8], [T.given, art['k19-given'], 'dissolve', 0.8]]
        layers(t, sequence).forEach(({ image, alpha }, i) => plate(tall[i], still(image, t), framed(image), camera, alpha))
      }

      // 风里的花瓣和叶子（画面空间，盖在最上面）
      if (t >= T.petals && t < T.gone + 1.2) {
        for (const p of wind) {
          const s = p.at(t)
          if (!s) continue
          engine.place((p.kind === 'petal' ? petal : leaf).texture, chain(translate(s.x, s.y), rotate(s.angle), scale(p.size * s.flip, p.size), translate(-0.5, -0.5)), { alpha: s.alpha })
        }
      }
    },
  }
}

/** 一镜：开始的时刻、图、怎么接上一镜（叠化，或先淡回纸面再淡入）、过渡时长 */
type Shot = readonly [number, Img, 'dissolve' | 'dip', number]

/** 这一刻要画的几层（最多两层）：叠化时新的一张盖在旧的上面慢慢显出来；dip 先淡出到纸、再淡入 */
function layers(t: number, list: readonly Shot[]): { image: Img; alpha: number }[] {
  const out: { image: Img; alpha: number }[] = []
  list.forEach(([start, image, kind, length], i) => {
    const enter = kind === 'dip' && i > 0 ? easeInOut(span(t, start - length * 0.2, start + length * 0.8)) : easeInOut(span(t, start - length, start))
    const next = list[i + 1]
    const leave = !next ? 1 : next[2] === 'dip' ? 1 - easeInOut(span(t, next[0] - next[3], next[0] - next[3] * 0.2)) : t < next[0] ? 1 : 0
    const alpha = (i === 0 && kind === 'dissolve' ? easeInOut(span(t, start, start + length)) : enter) * leave
    if (alpha > 0.001) out.push({ image, alpha })
  })
  return out
}

/** 一页上的图：宽 640，离中缝远一点（shift 往外移），不压中缝的阴影 */
function pictureOn(page: Box, shift: number): Box {
  const width = 640
  const height = width * 832 / 1216
  return { x: page.x + (page.width - width) / 2 + shift, y: 500 - height / 2, width, height }
}

/** 18 的上色：羽毛笔从她身边开始，顺着画面斜着来回刷，往两边铺开 */
function herWorld(): Job {
  const region: Region = { cx: 0.58, cy: 0.5, angle: -0.35, halfLength: 0.78, halfWidth: 0.6 }
  const { stroke, radius } = brushStrokes(region, 8, 4600, 23, 'outward')
  return { id: 'regrow', stroke, style: brush(radius), channel: 'paint', blend: 'add', mask: { kind: 'none' }, cursor: 'quill', fillMs: 800 }
}

interface QuillPose { x: number; y: number; down: boolean; alpha: number }

/** 羽毛笔的路线：落下 → 点墨 → 抬起去画第一笔 → 跟着笔触 → 画完从右上离开 */
function quillPose(t: number, touch: { x: number; y: number }, start: { x: number; y: number },
  cursor: { x: number; y: number; down: boolean } | null, paintedAt: number | null): QuillPose | null {
  if (t < T.quillIn) return null
  const enter = clamp((t - T.quillIn) / 0.3)
  if (t < T.touch - 0.15) {
    const f = easeOut(span(t, T.quillIn, T.touch - 0.15))
    return { x: lerp(touch.x + 520, touch.x + 4, f), y: lerp(touch.y - 640, touch.y - 10, f), down: false, alpha: enter }
  }
  if (t < T.touch + 0.3) return { x: touch.x, y: touch.y, down: t >= T.touch, alpha: 1 }
  if (paintedAt !== null) {
    const f = easeIn(span(t, paintedAt, paintedAt + 1.0))
    const from = cursor ?? start
    return { x: lerp(from.x, from.x + 700, f), y: lerp(from.y, from.y - 800, f), down: false, alpha: 1 - span(t, paintedAt + 0.6, paintedAt + 1.0) }
  }
  if (cursor) return { ...cursor, alpha: 1 }
  const f = easeInOut(span(t, T.touch + 0.3, T.paint))
  return { x: lerp(touch.x, start.x, f), y: lerp(touch.y, start.y, f) - Math.sin(Math.PI * f) * 60, down: false, alpha: 1 }
}

/** 羽毛笔：笔尖对准位置，斜 30°（和应用里一样），抬笔时略离开纸面 */
function drawQuill(engine: Engine, quill: Sprite, v: Affine, pose: QuillPose) {
  const height = 470
  const width = height * quill.width / quill.height
  const lift = pose.down ? [0, 0] : [10, -18]
  engine.place(quill.texture, chain(v, translate(pose.x + lift[0], pose.y + lift[1]), rotate(0.52), scale(width, height), translate(-QUILL_TIP[0], -QUILL_TIP[1])), { alpha: pose.alpha })
}

/** 风里的花瓣和叶子：出生时刻、位置、速度都由种子定；风越来越大，越来越密、越来越快 */
function makeWind() {
  const rand = random(1957)
  const list: { kind: 'petal' | 'leaf'; size: number; at(t: number): { x: number; y: number; angle: number; flip: number; alpha: number } | null }[] = []
  for (let born = T.petals; born < T.gone - 0.2;) {
    const strength = span(born, T.petals, T.sweep + 0.4)
    born += 1 / lerp(4, 46, strength)
    const speed = lerp(260, 1250, strength) * (0.75 + rand() * 0.5)
    const heading = -0.12 + (rand() - 0.5) * 0.5
    const vx = Math.cos(heading) * speed
    const vy = Math.sin(heading) * speed + 40
    const fromTop = rand() < 0.25
    const x0 = fromTop ? rand() * 1200 - 100 : -80 - rand() * 60
    const y0 = fromTop ? -70 : rand() * 1200 - 100
    const amp = 20 + rand() * 60
    const freq = 1 + rand() * 2.2
    const phase = rand() * Math.PI * 2
    const spin = (rand() - 0.5) * 9
    const flipRate = 1.5 + rand() * 4
    const kind = rand() < 0.7 ? 'petal' as const : 'leaf' as const
    const size = (kind === 'petal' ? 26 : 34) * (0.6 + rand() * 0.9)
    const start = born
    list.push({
      kind, size,
      at(t) {
        const age = t - start
        if (age < 0) return null
        const x = x0 + vx * age
        const y = y0 + vy * age + Math.sin(phase + age * freq * Math.PI * 2) * amp
        if (x > 2050 || y > 1200 || y < -200) return null
        return { x, y, angle: phase + spin * age, flip: Math.cos(phase * 1.7 + age * flipRate), alpha: clamp(age / 0.2) * 0.95 }
      },
    })
  }
  return list
}

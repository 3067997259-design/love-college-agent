/**
 * 纯浏览器预览用的假 bridge：没有 preload 时才启用，Electron 里一律走真实接口。
 * 切换场景时换一个 epoch，connectBridge 会按约定重新取快照。
 * 番茄钟照主进程的规则粗略模拟（技术方案 §3.5、docs/engineering/pomodoro.md），只为在浏览器里点得通；
 * 真正的计时、落盘和阶段事件都在主进程，这里点通不代表真实运行通过。
 */
import type { AppBridge, AppCommand, AppEvent, AppSnapshot, CommandAck, HistoryPhotoView, LifeView, OutingPlace, OutingView, PomodoroView, PublicErrorCode } from '../../../shared'
import { DEFAULT_SCENARIO, evidence, fakeDiary, fakeImpressions, fakePages, SCENARIOS, type ScenarioId } from './scenarios'

/** 预览用：把几行对话排成一张白底印刷页，返回 data URL（CSP 允许 img-src data:） */
function printedPage(lines: readonly string[]): string {
  const canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 640
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#222222'
  ctx.font = '22px "Microsoft YaHei UI", sans-serif'
  lines.forEach((line, index) => ctx.fillText(line, 32, 64 + index * 40, canvas.width - 64))
  return canvas.toDataURL('image/png')
}
import { sceneSrc } from '../book/Character'

/** 假旧页的“照片”：借一张整景图当那天拍下的样子（真实照片由主进程截当时的场景） */
function photoOf(sessionId: string): { photo?: HistoryPhotoView } {
  const page = fakePages[sessionId]
  const imageUrl = page?.photoPose ? sceneSrc(page.photoPose) : undefined
  return imageUrl ? { photo: { id: `photo-${sessionId}`, sessionId, dayKey: page.dayKey, capturedAtMs: 0, reason: 'day-end', imageUrl, width: 1254, height: 1254 } } : {}
}

export interface FakeBridge extends AppBridge {
  setScenario(id: ScenarioId): void
  /** 开发用：当前阶段直接到点，不用干等一分钟 */
  skipPhase(): void
  /** 开发用：模拟“恢复存档后重启”——换 epoch，备份状态为 restored，左页颜色重新长回来 */
  simulateRestore(): void
  /** 开发用：同一个 epoch 里出门／回来／入睡／唤醒／换时段，用来看左页的生活转场（真实的由主进程决定） */
  simulateLife(kind: 'depart' | 'return' | 'sleep' | 'wake' | 'daypart'): void
  readonly scenarioId: ScenarioId
}

const idleTimer = (): PomodoroView => ({ phase: 'idle', status: 'idle', remainingMs: 0, endsAtMs: null, focusIndex: 0, phaseDurationMs: 0, plannedCount: 0 })

export function createFakeBridge(initial: ScenarioId = DEFAULT_SCENARIO): FakeBridge {
  const listeners = new Set<(event: AppEvent) => void>()
  let scenarioId = initial
  let generation = 0
  let planCount = 0
  let restoreCount = 0
  let current: AppSnapshot = withEpoch(SCENARIOS[initial])
  // 剩余时间用 performance.now() 外推：渲染层不碰 Date 和 setTimeout（统一时钟规则）
  let anchor = { at: performance.now(), remaining: current.pomodoro.remainingMs }
  let pausedByLights = false
  let frame = 0

  function withEpoch(snapshot: AppSnapshot): AppSnapshot {
    generation += 1
    return { ...snapshot, epoch: `fake-${generation}`, revision: 1 }
  }
  function emit(reason: AppEvent['reason']) {
    const event: AppEvent = {
      protocolVersion: 1, epoch: current.epoch, revision: current.revision,
      occurredAtMs: current.clock.nowMs, type: 'state.snapshot', reason, snapshot: current,
    }
    for (const listener of listeners) listener(event)
  }
  function ack(command: AppCommand, error?: PublicErrorCode): CommandAck {
    const head = { protocolVersion: 1 as const, requestId: command.requestId, epoch: current.epoch }
    return error ? { ...head, status: 'rejected', error: { code: error, retryable: false } } : { ...head, status: 'accepted' }
  }
  function commit(patch: Partial<AppSnapshot>, reason: AppEvent['reason']) {
    const previous = current.pomodoro
    current = { ...current, ...patch, revision: current.revision + 1 }
    if (patch.pomodoro) {
      const view = current.pomodoro
      current.pomodoro = { ...view, completedCount: Math.max(0, view.focusIndex - (view.phase === 'focus' ? 1 : 0)) }
      // A draft or confirmation with the same deadline must not restart the preview countdown.
      if (view.phase !== previous.phase || view.status !== previous.status || view.endsAtMs !== previous.endsAtMs) anchor = { at: performance.now(), remaining: view.remainingMs }
    }
    emit(reason)
    watch()
  }

  /* —— 番茄钟 —— */
  function left(): number {
    const { pomodoro, clock } = current
    if (pomodoro.status !== 'running' || clock.frozen) return pomodoro.remainingMs
    return Math.max(0, anchor.remaining - (performance.now() - anchor.at) * clock.rate)
  }
  const run = (view: PomodoroView, remainingMs: number): PomodoroView =>
    ({ ...view, status: 'running', remainingMs, endsAtMs: current.clock.nowMs + remainingMs })
  /** 计时在跑就每帧看一眼，到点按主进程的规则翻到下一阶段 */
  function watch() {
    cancelAnimationFrame(frame)
    if (current.pomodoro.status !== 'running') return
    const tick = () => { if (left() <= 0) advance(false); else frame = requestAnimationFrame(tick) }
    frame = requestAnimationFrame(tick)
  }
  /** 专注到点或提前翻牌 → 休息（提前的不算完成）；休息到点 → 等你开始下一个，不自动开始 */
  function advance(interrupted: boolean) {
    const view = current.pomodoro
    const plan = view.plan
    if (!plan || view.phase === 'idle') return
    if (view.phase === 'focus') {
      const index = interrupted ? Math.max(0, view.focusIndex - 1) : view.focusIndex
      const long = !interrupted && index % plan.longBreakEvery === 0
      const duration = long ? plan.longBreakDurationMs : plan.shortBreakDurationMs
      commit({
        pomodoro: run({ ...view, phase: long ? 'long-break' : 'short-break', focusIndex: index, phaseDurationMs: duration }, duration),
        companion: { ...current.companion, mode: 'rest', pose: 'facing-user', expression: 'smile' },
      }, 'timer')
      return
    }
    const finished = view.focusIndex >= plan.plannedCount
    commit({ pomodoro: { ...view, phase: 'idle', status: 'idle', remainingMs: 0, endsAtMs: null, phaseDurationMs: 0, plan: { ...plan, status: finished ? 'finished' : 'confirmed' } } }, 'timer')
  }
  function pomodoroCommand(command: AppCommand): PublicErrorCode | undefined {
    const view = current.pomodoro
    const plan = view.plan
    const { lightsOut } = current.companion
    switch (command.type) {
      case 'pomodoro.plan': {
        // 草案只写 proposal：不动生效计划、进度和正在走的计时；已有草案就替换草案
        if (command.plan.plannedCount < view.focusIndex) return 'invalid-command'
        const next = { ...command.plan, id: `fake-plan-${++planCount}`, createdAtMs: current.clock.nowMs, status: 'proposed' as const, source: 'user' as const }
        commit({ pomodoro: { ...view, proposal: next } }, 'timer')
        return
      }
      case 'pomodoro.confirm': {
        const proposal = view.proposal
        if (!proposal || proposal.id !== command.planId) return 'invalid-command'
        if (proposal.plannedCount < view.focusIndex) return 'invalid-command'
        // 任何阶段都能确认：当前阶段照走，已完成的保留，总数换成新的
        const { proposal: _dropped, ...rest } = view
        void _dropped
        commit({ pomodoro: { ...rest, plan: { ...proposal, status: view.status === 'idle' && view.focusIndex === proposal.plannedCount ? 'finished' : 'confirmed' }, plannedCount: proposal.plannedCount } }, 'timer')
        return
      }
      case 'pomodoro.discard': {
        if (!view.proposal || view.proposal.id !== command.planId) return 'invalid-command'
        const { proposal: _dropped, ...rest } = view
        void _dropped
        commit({ pomodoro: rest }, 'timer')
        return
      }
      case 'pomodoro.start':
        if (lightsOut || view.status !== 'idle') return 'unavailable'
        if (!plan || plan.id !== command.planId || plan.status !== 'confirmed' || view.focusIndex >= plan.plannedCount) return 'invalid-command'
        commit({
          pomodoro: run({ ...view, phase: 'focus', focusIndex: view.focusIndex + 1, phaseDurationMs: plan.focusDurationMs }, plan.focusDurationMs),
          companion: { ...current.companion, mode: 'quiet', pose: 'desk-computer', expression: 'think' },
        }, 'timer')
        return
      case 'pomodoro.pause':
        if (view.status !== 'running') return 'unavailable'
        pausedByLights = false
        commit({ pomodoro: { ...view, status: 'paused', remainingMs: Math.round(left()), endsAtMs: null } }, 'timer')
        return
      case 'pomodoro.resume':
        if (view.status !== 'paused' || lightsOut) return 'unavailable'
        commit({ pomodoro: run(view, view.remainingMs) }, 'timer')
        return
      case 'pomodoro.stop':
        if (!plan || plan.status === 'finished') return 'unavailable'
        commit({
          pomodoro: { ...idleTimer(), plan: { ...plan, status: 'finished' }, plannedCount: view.plannedCount, focusIndex: Math.max(0, view.focusIndex - (view.phase === 'focus' ? 1 : 0)),
            ...(view.proposal ? { proposal: view.proposal } : {}) },
          companion: { ...current.companion, mode: 'rest' },
        }, 'timer')
        return
      default:
        return 'unavailable'
    }
  }

  watch()
  return {
    get scenarioId() { return scenarioId },
    setScenario(id) {
      scenarioId = id
      current = withEpoch(SCENARIOS[id])
      anchor = { at: performance.now(), remaining: current.pomodoro.remainingMs }
      pausedByLights = false
      emit('restore')
      watch()
    },
    skipPhase() { if (current.pomodoro.status !== 'idle') advance(false) },
    simulateRestore() {
      restoreCount += 1
      current = withEpoch({ ...current, backup: { status: 'restored', operationId: `fake-restore-${Math.round(performance.timeOrigin)}-${restoreCount}`,
        incoming: { savedAtMs: current.clock.nowMs, source: 'fake', pageCount: 2, messageCount: 18, memoryCount: 6, deliveryCount: 2 } } })
      emit('restore')
    },
    simulateLife(kind) {
      const now = current.clock.nowMs
      const life: LifeView = current.life ?? { dayKey: '2026-10-17', userSchedule: 'rest', locationId: 'room', settledUntilMs: now, agenda: [], outings: [], items: [] }
      const companion = current.companion
      if (kind === 'depart') {
        if (life.locationId !== 'room' || companion.sleeping || companion.pose === 'sleeping') return
        const place: OutingPlace = life.outings.length % 2 ? 'swing' : 'coast'
        const outing: OutingView = { id: `out-fake-${life.outings.length + 1}`, place, startsAtMs: now, returnsAtMs: now + 150 * 60_000, acquiredAtMs: now + 90 * 60_000, item: place === 'coast' ? 'shell' : 'leaf', status: 'away', settledAtMs: null, offline: false }
        commit({ life: { ...life, locationId: place, outings: [...life.outings, outing] }, companion: { ...companion, locationId: place } }, 'task')
      } else if (kind === 'return') {
        const outing = life.outings.find((item) => item.status === 'away')
        if (!outing) return
        const items = [...life.items, { id: `item:${outing.id}`, outingId: outing.id, dayKey: life.dayKey, place: outing.place, kind: outing.item, acquiredAtMs: outing.acquiredAtMs, display: 'desk' as const }]
        commit({
          life: { ...life, locationId: 'room', outings: life.outings.map((item) => item.id === outing.id ? { ...item, status: 'returned', settledAtMs: now } : item), items: items.map((item, i) => ({ ...item, display: i >= items.length - 3 ? 'desk' : 'drawer' })) },
          companion: { ...companion, locationId: 'room', mode: 'rest', pose: 'facing-user', expression: 'smile' },
          messages: [...current.messages, { id: `back-${outing.id}`, role: 'assistant', text: outing.place === 'coast' ? '回来了。海边风很大，捡了一个贝壳。' : '回来了。秋千那儿落了好多叶子，带了一片。', createdAtMs: now, status: 'complete', emotion: 'smile' }],
        }, 'task')
      } else if (kind === 'sleep') {
        if (companion.locationId !== 'room') return
        commit({ companion: { ...companion, sleeping: true, pose: 'sleeping', expression: 'calm' } }, 'mode')
      } else if (kind === 'wake') {
        commit({ companion: { ...companion, sleeping: false, mode: 'rest', pose: 'facing-user', expression: 'calm' } }, 'mode')
      } else {
        const order = ['morning', 'day', 'evening', 'night'] as const
        commit({ companion: { ...companion, daypart: order[(order.indexOf(companion.daypart) + 1) % order.length] } }, 'mode')
      }
    },
    async getSnapshot() { return current },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async dispatch(command) {
      if (command.epoch !== current.epoch) {
        return { protocolVersion: 1, requestId: command.requestId, epoch: current.epoch, status: 'rejected', error: { code: 'stale-epoch', retryable: true } }
      }
      if (command.type.startsWith('onboarding.')) {
        const profile = current.onboarding ?? { status: 'needed' as const, userName: null, characterName: '桃子', completedAtMs: null }
        if (command.type === 'onboarding.profile') commit({ onboarding: { ...profile, ...(command.userName !== undefined ? { userName: command.userName.trim() || null } : {}), ...(command.characterName !== undefined ? { characterName: command.characterName.trim() || '桃子' } : {}) } }, 'connection')
        else if (command.type === 'onboarding.complete') commit({ onboarding: { ...profile, status: 'completed', completedAtMs: profile.completedAtMs ?? current.clock.nowMs } }, 'connection')
        else if (command.type === 'onboarding.reset') commit({ onboarding: { ...profile, status: 'needed', completedAtMs: null } }, 'connection')
        return ack(command)
      }
      const view = current.pomodoro
      if (command.type === 'mode.set') {
        // 专注时把门牌翻到“休息”＝提前结束这一段（技术方案 §3.5）
        const interrupt = command.mode === 'rest' && !current.companion.lightsOut && view.phase === 'focus' && view.status !== 'idle'
        commit({ companion: { ...current.companion, mode: command.mode } }, 'mode')
        if (interrupt) advance(true)
        return ack(command)
      }
      if (command.type === 'lights.set') {
        commit({ companion: { ...current.companion, lightsOut: command.lightsOut } }, 'mode')
        if (command.lightsOut && view.status === 'running') {
          pausedByLights = true
          commit({ pomodoro: { ...view, status: 'paused', remainingMs: Math.round(left()), endsAtMs: null } }, 'timer')
        } else if (!command.lightsOut && view.status === 'paused' && pausedByLights) {
          pausedByLights = false
          commit({ pomodoro: run(view, view.remainingMs) }, 'timer')
        }
        return ack(command)
      }
      if (command.type === 'backup.export') {
        if (current.backup && ['exporting', 'validating', 'restoring'].includes(current.backup.status)) return ack(command, 'unavailable')
        commit({ backup: { status: 'exporting', operationId: `fake-export-${current.revision}` } }, 'task')
        // 预览里没有原生对话框：过一会儿当作写好了
        const startedAt = performance.now()
        const wait = () => {
          if (current.backup?.status !== 'exporting') return
          if (performance.now() - startedAt < 1200) { requestAnimationFrame(wait); return }
          commit({ backup: { status: 'exported', operationId: current.backup.operationId, archiveId: 'fake-archive', exportedAtMs: current.clock.nowMs } }, 'task')
        }
        requestAnimationFrame(wait)
        return ack(command)
      }
      if (command.type === 'backup.cancel') {
        commit({ backup: { status: 'idle' } }, 'task')
        return ack(command)
      }
      // 引用回忆：问题作为你的话进对话，“正在回忆”一会儿，再来一句假回答；只为看画面，不是回忆的真实行为
      if (command.type === 'history.recall' && current.history) {
        const page = fakePages[command.anchor.sessionId]
        if (!page?.recallable.includes(command.anchor.messageId) || current.history.recall.status === 'recalling') return ack(command, 'unavailable')
        const requestId = command.requestId
        commit({
          messages: [...current.messages, { id: `q-${requestId}`, role: 'user', text: command.question, createdAtMs: current.clock.nowMs, status: 'complete' }],
          history: { ...current.history, recall: { status: 'recalling', requestId, anchor: command.anchor, dayKey: page.dayKey, sourceCount: 3, ...photoOf(command.anchor.sessionId) } },
        }, 'task')
        const startedAt = performance.now()
        const wait = () => {
          if (current.history?.recall.requestId !== requestId) return
          if (performance.now() - startedAt < 2600) { requestAnimationFrame(wait); return }
          commit({
            messages: [...current.messages, { id: `r-${requestId}`, role: 'assistant', text: '嗯，那天你说写完了想喝点热的。所以杯子是那天记下的。', createdAtMs: current.clock.nowMs, status: 'complete', emotion: 'smile' }],
            history: { ...current.history!, recall: { ...current.history!.recall, status: 'ready' } },
          }, 'task')
        }
        requestAnimationFrame(wait)
        return ack(command)
      }
      // 书桌作品：停下／接着做只改状态，步数不动；“看看”是原生预览，预览里没有
      if ((command.type === 'life.work.pause' || command.type === 'life.work.resume') && current.life?.work) {
        const work = current.life.work
        const job = work.jobs.find((item) => item.id === command.workId)
        const next = command.type === 'life.work.pause' ? (job?.status === 'running' ? 'paused' : null) : (job && ['paused', 'interrupted'].includes(job.status) ? 'running' : null)
        if (!job || !next) return ack(command, 'unavailable')
        commit({ life: { ...current.life, work: { ...work, runningId: next === 'running' ? job.id : null, jobs: work.jobs.map((item) => item.id === job.id ? { ...item, status: next, reason: next === 'paused' ? 'user' : undefined } : item) } } }, 'task')
        return ack(command)
      }
      // 礼物架上点得通：提议的可以开始（只在专注里）或不要，做着的可以停下；做没做好仍是假数据
      if ((command.type === 'gift.start' || command.type === 'gift.cancel') && current.gifts) {
        const gift = current.gifts.items.find((item) => item.id === command.giftId)
        const focusing = view.phase === 'focus' && view.status === 'running'
        const next = command.type === 'gift.start' ? (gift?.status === 'proposed' && focusing ? 'making' : null) : (gift && ['proposed', 'making'].includes(gift.status) ? 'cancelled' : null)
        if (!gift || !next) return ack(command, 'unavailable')
        commit({ gifts: { ...current.gifts, items: current.gifts.items.map((item) => item.id === gift.id ? { ...item, status: next } : item) } }, 'task')
        return ack(command)
      }
      // 其余命令明确拒绝，不假装执行过
      return ack(command, command.type.startsWith('pomodoro.') ? pomodoroCommand(command) : 'unavailable')
    },
    async readEvidence(ref) {
      const view = evidence[ref]
      if (!view) throw new Error('evidence not found')
      return view
    },
    async readSession(id) {
      const page = fakePages[id]
      if (!page) throw new Error('SESSION_UNAVAILABLE')
      return { sessionId: id, dayKey: page.dayKey, messages: page.messages, truncated: false, recallableMessageIds: page.recallable, ...photoOf(id) }
    },
    // 封页小样：预览里用画布现画一张印刷页（真实的是主进程渲染并存进私人资产的 PNG）
    async readOpticalMemory(frameId) {
      const frame = current.opticalMemory?.frames.find((item) => item.id === frameId)
      const impressions = fakeImpressions[frameId]
      if (!frame || !impressions) throw new Error('OPTICAL_UNAVAILABLE')
      return { frameId, imageUrl: printedPage(fakePages[frame.sessionId]?.messages.map((m) => `${m.role === 'user' ? '你' : '她'}：${m.text}`) ?? []), impressions, uncertainty: 'unreviewed-impression' }
    },
    // 和主进程一样：没解锁就打不开
    async readDiary(id) {
      const entry = current.diary?.entries.find((item) => item.id === id)
      const text = fakeDiary[id]
      if (!entry?.unlocked || !text) throw new Error('DIARY_LOCKED')
      return { id, dayKey: entry.dayKey, text, key: 'A1B2C3D4E5F60718', subjective: true }
    },
  }
}

export function scenarioFromUrl(search: string): ScenarioId {
  const id = new URLSearchParams(search).get('scenario')
  return id && id in SCENARIOS ? (id as ScenarioId) : DEFAULT_SCENARIO
}

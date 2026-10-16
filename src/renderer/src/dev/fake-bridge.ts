/**
 * 纯浏览器预览用的假 bridge：没有 preload 时才启用，Electron 里一律走真实接口。
 * 切换场景时换一个 epoch，connectBridge 会按约定重新取快照。
 * 番茄钟照主进程的规则粗略模拟（技术方案 §3.5、docs/engineering/pomodoro.md），只为在浏览器里点得通；
 * 真正的计时、落盘和阶段事件都在主进程，这里点通不代表真实运行通过。
 */
import type { AppBridge, AppCommand, AppEvent, AppSnapshot, CommandAck, PomodoroView, PublicErrorCode } from '../../../shared'
import { DEFAULT_SCENARIO, evidence, SCENARIOS, type ScenarioId } from './scenarios'

export interface FakeBridge extends AppBridge {
  setScenario(id: ScenarioId): void
  /** 开发用：当前阶段直接到点，不用干等一分钟 */
  skipPhase(): void
  readonly scenarioId: ScenarioId
}

const idleTimer = (): PomodoroView => ({ phase: 'idle', status: 'idle', remainingMs: 0, endsAtMs: null, focusIndex: 0, phaseDurationMs: 0, plannedCount: 0 })

export function createFakeBridge(initial: ScenarioId = DEFAULT_SCENARIO): FakeBridge {
  const listeners = new Set<(event: AppEvent) => void>()
  let scenarioId = initial
  let generation = 0
  let planCount = 0
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
    current = { ...current, ...patch, revision: current.revision + 1 }
    if (patch.pomodoro) anchor = { at: performance.now(), remaining: current.pomodoro.remainingMs }
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
        if (view.status !== 'idle') return 'unavailable'
        const next = { ...command.plan, id: `fake-plan-${++planCount}`, createdAtMs: current.clock.nowMs, status: 'proposed' as const, source: 'user' as const }
        commit({ pomodoro: { ...idleTimer(), plan: next, plannedCount: next.plannedCount } }, 'timer')
        return
      }
      case 'pomodoro.confirm':
        if (!plan || plan.id !== command.planId || plan.status !== 'proposed') return 'invalid-command'
        commit({ pomodoro: { ...view, plan: { ...plan, status: 'confirmed' } } }, 'timer')
        return
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
        if (view.status === 'idle' && !plan) return 'unavailable'
        commit({
          pomodoro: { ...idleTimer(), ...(plan ? { plan: { ...plan, status: 'finished' as const }, plannedCount: view.plannedCount, focusIndex: view.focusIndex } : {}) },
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
    async getSnapshot() { return current },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async dispatch(command) {
      if (command.epoch !== current.epoch) {
        return { protocolVersion: 1, requestId: command.requestId, epoch: current.epoch, status: 'rejected', error: { code: 'stale-epoch', retryable: true } }
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
      // 其余命令明确拒绝，不假装执行过
      return ack(command, command.type.startsWith('pomodoro.') ? pomodoroCommand(command) : 'unavailable')
    },
    async readEvidence(ref) {
      const view = evidence[ref]
      if (!view) throw new Error('evidence not found')
      return view
    },
  }
}

export function scenarioFromUrl(search: string): ScenarioId {
  const id = new URLSearchParams(search).get('scenario')
  return id && id in SCENARIOS ? (id as ScenarioId) : DEFAULT_SCENARIO
}

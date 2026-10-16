/**
 * 纯浏览器预览用的假 bridge：没有 preload 时才启用，Electron 里一律走真实接口。
 * 切换场景时换一个 epoch，connectBridge 会按约定重新取快照。
 */
import type { AppBridge, AppCommand, AppEvent, AppSnapshot, CommandAck } from '../../../shared'
import { DEFAULT_SCENARIO, evidence, SCENARIOS, type ScenarioId } from './scenarios'

export interface FakeBridge extends AppBridge {
  setScenario(id: ScenarioId): void
  readonly scenarioId: ScenarioId
}

export function createFakeBridge(initial: ScenarioId = DEFAULT_SCENARIO): FakeBridge {
  const listeners = new Set<(event: AppEvent) => void>()
  let scenarioId = initial
  let generation = 0
  let current: AppSnapshot = withEpoch(SCENARIOS[initial])

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
  function ack(command: AppCommand, ok: boolean): CommandAck {
    const head = { protocolVersion: 1 as const, requestId: command.requestId, epoch: current.epoch }
    return ok ? { ...head, status: 'accepted' } : { ...head, status: 'rejected', error: { code: 'unavailable', retryable: false } }
  }

  return {
    get scenarioId() { return scenarioId },
    setScenario(id) {
      scenarioId = id
      current = withEpoch(SCENARIOS[id])
      emit('restore')
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
      // 只模拟两个纯界面状态，其余命令明确拒绝，不假装执行过
      if (command.type === 'mode.set' || command.type === 'lights.set') {
        const companion = command.type === 'mode.set'
          ? { ...current.companion, mode: command.mode }
          : { ...current.companion, lightsOut: command.lightsOut }
        current = { ...current, revision: current.revision + 1, companion }
        emit('mode')
        return ack(command, true)
      }
      return ack(command, false)
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

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, AppEvent, AppSnapshot, CommandAck, PublicErrorCode, RuntimeView, ClockView } from '../../shared'
import { DEFAULT_EXPRESSION, PROTOCOL_VERSION } from '../../shared'
import type { Clock } from '../clock'
import { deriveDaypart, type DaypartSchedule } from '../clock/daypart'
import type { SessionStore } from '../store/session'
import { commandHash } from '../journal/file'

const envelope = { protocolVersion: z.literal(PROTOCOL_VERSION), requestId: z.string().min(1).max(128), epoch: z.string().min(1).max(128) }
const schema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('message.send'), text: z.string().trim().min(1).max(20_000) }),
  z.strictObject({ ...envelope, type: z.literal('turn.stop'), taskId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('mode.set'), mode: z.enum(['work', 'quiet', 'rest']) }),
  z.strictObject({ ...envelope, type: z.literal('lights.set'), lightsOut: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('pomodoro.start'), planId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('pomodoro.pause') }),
  z.strictObject({ ...envelope, type: z.literal('pomodoro.stop') }),
  z.strictObject({ ...envelope, type: z.literal('candidate.confirm'), candidateId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('candidate.ignore'), candidateId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('artifact.open'), artifactId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('backup.export') }),
  z.strictObject({ ...envelope, type: z.literal('backup.import') }),
  z.strictObject({ ...envelope, type: z.literal('privacy.set'), enabled: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('plugin.enable'), pluginId: z.string().min(1).max(64), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...envelope, type: z.literal('plugin.disable'), pluginId: z.string().min(1).max(64) }),
  z.strictObject({ ...envelope, type: z.literal('plugin.privacy.set'), pluginId: z.string().min(1).max(64), privacy: z.enum(['none', 'optional', 'always']) }),
  z.strictObject({ ...envelope, type: z.literal('developer.set'), enabled: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('developer.clock'), nowMs: z.number().int().min(0).max(8_640_000_000_000_000).optional(), rate: z.number().min(0.01).max(3600).optional(), frozen: z.boolean().optional() }),
  z.strictObject({ ...envelope, type: z.literal('developer.scenario'), scenarioId: z.enum(['empty', 'clock-tool', 'pomodoro-demo']) }),
  z.strictObject({ ...envelope, type: z.literal('app.restart') }),
])

export interface RuntimePort {
  view(): RuntimeView
  clockView?(): Pick<ClockView, 'rate' | 'frozen'>
  dispatch(command: AppCommand): PublicErrorCode | undefined
  stateChanged?(command: AppCommand): void
}

export function createAppController(clock: Clock, daypartSchedule?: DaypartSchedule, store?: SessionStore) {
  const listeners = new Set<(event: AppEvent) => void>()
  const requests = new Map<string, { signature: string; ack: CommandAck }>()
  const snapshot: AppSnapshot = {
    protocolVersion: PROTOCOL_VERSION, epoch: randomUUID(), revision: 0,
    scope: { userId: 'local-user', characterId: 'default-character', sessionId: randomUUID() },
    clock: { nowMs: clock.nowMs(), timeZone: 'Asia/Shanghai', rate: 1, frozen: false },
    companion: { mode: 'rest', lightsOut: false, locationId: 'room', pose: 'facing-user', expression: DEFAULT_EXPRESSION,
      daypart: deriveDaypart(clock.nowMs(), daypartSchedule), mailboxUnseen: 0 },
    pomodoro: { phase: 'idle', status: 'idle', remainingMs: 0, endsAtMs: null, focusIndex: 0, phaseDurationMs: 0, plannedCount: 0 },
    task: null, messages: [], activities: [], candidates: [], deliveries: [],
    capabilities: (['chat', 'pomodoro', 'mail', 'privacy', 'memory', 'backup', 'mcp', 'rodin', 'heart-flow'] as const).map((id) => ({
      id, status: 'unavailable' as const, source: 'none' as const,
    })),
    privacy: { mode: 'follow-main', fileFilteringEnabled: false },
  }
  if (store) {
    const saved = store.projection()
    snapshot.scope = saved.scope
    snapshot.companion.mode = saved.mode
    snapshot.companion.lightsOut = saved.lightsOut
    snapshot.messages = saved.messages
    snapshot.activities = saved.activities
    snapshot.task = saved.task
    for (const request of saved.requests.slice(-1000)) requests.set(request.requestId, { signature: request.commandHash,
      ack: { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, epoch: snapshot.epoch, status: 'accepted' } })
  }
  const updatePose = () => { snapshot.companion.pose = snapshot.companion.lightsOut ? 'sleeping' : { work: 'desk-computer', quiet: 'desk-writing', rest: 'facing-user' }[snapshot.companion.mode] }
  updatePose()
  let execution: { source: 'real' | 'fake'; send(text: string, requestId: string, hash: string): void; stop(id: string): boolean; stateChanged(): void } | undefined
  let executionReady = false
  let runtime: RuntimePort | undefined
  const readProjection = () => {
    if (!store) return
    const view = store.projection()
    snapshot.companion.mode = view.mode; snapshot.companion.lightsOut = view.lightsOut
    snapshot.messages = view.messages; snapshot.activities = view.activities; snapshot.task = view.task
    updatePose()
  }
  const publish = (reason: AppEvent['reason'], requestId?: string) => {
    snapshot.revision++
    snapshot.clock.nowMs = clock.nowMs()
    if (runtime) { snapshot.runtime = runtime.view(); Object.assign(snapshot.clock, runtime.clockView?.()) }
    snapshot.companion.daypart = deriveDaypart(snapshot.clock.nowMs, daypartSchedule)
    const event: AppEvent = { protocolVersion: PROTOCOL_VERSION, epoch: snapshot.epoch, revision: snapshot.revision,
      occurredAtMs: snapshot.clock.nowMs, type: 'state.snapshot', reason, snapshot: structuredClone(snapshot), ...(requestId ? { requestId } : {}) }
    for (const listener of listeners) listener(event)
  }
  const reject = (requestId: string, code: PublicErrorCode): CommandAck => ({
    protocolVersion: PROTOCOL_VERSION, requestId, epoch: snapshot.epoch, status: 'rejected', error: { code, retryable: false },
  })
  const dispatch = (input: unknown): CommandAck => {
    const parsed = schema.safeParse(input)
    if (!parsed.success) return reject('invalid', 'invalid-command')
    const command: AppCommand = parsed.data
    if (command.epoch !== snapshot.epoch) return reject(command.requestId, 'stale-epoch')
    const signature = commandHash(command)
    const prior = requests.get(command.requestId)
    if (prior) return prior.signature === signature ? structuredClone(prior.ack) : reject(command.requestId, 'invalid-command')
    let ack: CommandAck
    if (command.type === 'mode.set') {
      try { store?.append({ type: 'companion/mode', mode: command.mode, requestId: command.requestId, commandHash: signature }) }
      catch { return reject(command.requestId, 'internal') }
      snapshot.companion.mode = command.mode
      runtime?.stateChanged?.(command)
      readProjection()
      updatePose()
      publish('mode', command.requestId)
      execution?.stateChanged()
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (command.type === 'lights.set') {
      try { store?.append({ type: 'companion/lights', lightsOut: command.lightsOut, requestId: command.requestId, commandHash: signature }) }
      catch { return reject(command.requestId, 'internal') }
      snapshot.companion.lightsOut = command.lightsOut
      runtime?.stateChanged?.(command)
      readProjection()
      updatePose()
      publish('mode', command.requestId)
      execution?.stateChanged()
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (command.type === 'message.send' && execution && executionReady && !snapshot.companion.lightsOut) {
      try { execution.send(command.text, command.requestId, signature) }
      catch { return reject(command.requestId, 'internal') }
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (command.type === 'turn.stop' && execution) {
      if (!execution.stop(command.taskId)) return reject(command.requestId, 'invalid-command')
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (runtime && (command.type.startsWith('plugin.') || command.type.startsWith('developer.') || command.type === 'app.restart')) {
      try {
        const error = runtime.dispatch(command)
        ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
        publish('connection', command.requestId)
      } catch { ack = reject(command.requestId, 'internal') }
    } else {
      ack = reject(command.requestId, command.type === 'privacy.set' ? 'privacy-unavailable' : command.type === 'message.send' && execution && !snapshot.companion.lightsOut ? 'not-configured' : 'unavailable')
    }
    requests.set(command.requestId, { signature, ack })
    if (requests.size > 1000) requests.delete(requests.keys().next().value!)
    return structuredClone(ack)
  }
  let stopTimer: (() => void) | undefined
  let ticking = false
  const tick = () => { if (!ticking) return; publish('timer'); stopTimer = clock.after(1000, tick) }
  return {
    getSnapshot: () => structuredClone(snapshot), dispatch,
    attachRuntime: (port: RuntimePort) => { runtime = port; publish('connection') },
    refresh: (reason: AppEvent['reason']) => { readProjection(); publish(reason) },
    attachExecution: (port: NonNullable<typeof execution>, ready: boolean) => {
      execution = port; executionReady = ready
      snapshot.capabilities = snapshot.capabilities.map((item) => item.id === 'chat' ? { id: 'chat', status: ready ? 'ready' : 'unconfigured', source: ready ? port.source : 'none' } : item)
      publish('connection')
    },
    subscribe: (listener: (event: AppEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => { if (!ticking) { ticking = true; stopTimer = clock.after(1000, tick) } },
    dispose: () => { ticking = false; stopTimer?.(); listeners.clear(); requests.clear() },
  }
}

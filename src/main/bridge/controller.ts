import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, AppEvent, AppSnapshot, CommandAck, PublicErrorCode } from '../../shared'
import { PROTOCOL_VERSION } from '../../shared'
import type { Clock } from '../clock'

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
])

export function createAppController(clock: Clock) {
  const listeners = new Set<(event: AppEvent) => void>()
  const requests = new Map<string, { signature: string; ack: CommandAck }>()
  const snapshot: AppSnapshot = {
    protocolVersion: PROTOCOL_VERSION, epoch: randomUUID(), revision: 0,
    scope: { userId: 'local-user', characterId: 'default-character', sessionId: randomUUID() },
    clock: { nowMs: clock.nowMs(), timeZone: 'Asia/Shanghai', rate: 1, frozen: false },
    companion: { mode: 'rest', lightsOut: false, locationId: 'room', pose: 'facing-user', expression: 'neutral' },
    pomodoro: { phase: 'idle', status: 'idle', remainingMs: 0, endsAtMs: null, focusIndex: 0 },
    task: null, messages: [], activities: [], candidates: [], deliveries: [],
    capabilities: (['chat', 'pomodoro', 'mail', 'privacy', 'memory', 'backup', 'mcp', 'rodin', 'heart-flow'] as const).map((id) => ({
      id, status: 'unavailable' as const, source: 'none' as const,
    })),
    privacy: { mode: 'follow-main', fileFilteringEnabled: false },
  }
  const publish = (reason: AppEvent['reason'], requestId?: string) => {
    snapshot.revision++
    snapshot.clock.nowMs = clock.nowMs()
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
    const signature = JSON.stringify(command)
    const prior = requests.get(command.requestId)
    if (prior) return prior.signature === signature ? structuredClone(prior.ack) : reject(command.requestId, 'invalid-command')
    let ack: CommandAck
    if (command.type === 'mode.set') {
      snapshot.companion.mode = command.mode
      snapshot.companion.pose = { work: 'computer', quiet: 'writing', rest: 'facing-user' }[command.mode]
      publish('mode', command.requestId)
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (command.type === 'lights.set') {
      snapshot.companion.lightsOut = command.lightsOut
      publish('mode', command.requestId)
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else {
      ack = reject(command.requestId, command.type === 'privacy.set' ? 'privacy-unavailable' : 'unavailable')
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
    subscribe: (listener: (event: AppEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => { if (!ticking) { ticking = true; stopTimer = clock.after(1000, tick) } },
    dispose: () => { ticking = false; stopTimer?.(); listeners.clear(); requests.clear() },
  }
}

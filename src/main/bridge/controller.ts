import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppCommand, AppEvent, AppSnapshot, CommandAck, DiagnosticsView, PublicErrorCode, RuntimeView, ClockView } from '../../shared'
import { DEFAULT_EXPRESSION, PROTOCOL_VERSION } from '../../shared'
import type { Clock } from '../clock'
import { deriveDaypart, type DaypartSchedule } from '../clock/daypart'
import type { SessionStore } from '../store/session'
import { commandHash } from '../journal/file'
import { planSchema } from '../pomodoro/schema'
import type { PomodoroService } from '../pomodoro/service'
import type { CampusService } from '../campus/service'
import { MAIL_SCENARIO_IDS } from '../../shared'
import { DOCUMENT_SCENARIO_IDS, type FileImportAck } from '../../shared'
import type { DocumentService } from '../documents/service'
import type { MemoryService } from '../memory/service'
import type { McpService } from '../mcp/service'
import type { BackupService } from '../backup/service'
import type { QuillService } from '../gifts/quill'
import type { ModelSettingsService } from '../config/model-settings'
import type { CompanionWindows, WindowSurface } from '../windows/companion'

const envelope = { protocolVersion: z.literal(PROTOCOL_VERSION), requestId: z.string().min(1).max(128), epoch: z.string().min(1).max(128) }
const schema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('message.send'), text: z.string().trim().min(1).max(20_000) }),
  z.strictObject({ ...envelope, type: z.literal('turn.stop'), taskId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('mode.set'), mode: z.enum(['work', 'quiet', 'rest']) }),
  z.strictObject({ ...envelope, type: z.literal('lights.set'), lightsOut: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('pomodoro.start'), planId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('pomodoro.plan'), plan: planSchema }),
  z.strictObject({ ...envelope, type: z.literal('pomodoro.confirm'), planId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('pomodoro.discard'), planId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('pomodoro.resume') }),
  z.strictObject({ ...envelope, type: z.literal('pomodoro.pause') }),
  z.strictObject({ ...envelope, type: z.literal('pomodoro.stop') }),
  z.strictObject({ ...envelope, type: z.literal('mail.scan') }),
  z.strictObject({ ...envelope, type: z.literal('candidate.confirm'), candidateId: z.string().min(1).max(128), expectedRevision: z.number().int().positive().optional(), plannedCompletionIso: z.iso.datetime({ offset: true }).nullable().optional() }),
  z.strictObject({ ...envelope, type: z.literal('candidate.ignore'), candidateId: z.string().min(1).max(128), expectedRevision: z.number().int().positive().optional() }),
  z.strictObject({ ...envelope, type: z.literal('campus.export') }),
  z.strictObject({ ...envelope, type: z.literal('artifact.open'), artifactId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('backup.export') }),
  z.strictObject({ ...envelope, type: z.literal('backup.import') }),
  z.strictObject({ ...envelope, type: z.literal('backup.restore'), restoreId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('backup.cancel') }),
  z.strictObject({ ...envelope, type: z.literal('mcp.configure') }),
  z.strictObject({ ...envelope, type: z.literal('mcp.connect'), serverId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...envelope, type: z.literal('mcp.disconnect'), serverId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/) }),
  z.strictObject({ ...envelope, type: z.literal('models.configure') }),
  z.strictObject({ ...envelope, type: z.literal('window.mini') }),
  z.strictObject({ ...envelope, type: z.literal('window.expand') }),
  z.strictObject({ ...envelope, type: z.literal('window.book') }),
  z.strictObject({ ...envelope, type: z.literal('window.mini.hover'), over: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('window.mini.move'), dx: z.number().int().min(-10000).max(10000), dy: z.number().int().min(-10000).max(10000) }),
  z.strictObject({ ...envelope, type: z.literal('privacy.set'), enabled: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('document.attachment'), attachmentId: z.string().max(128) }),
  z.strictObject({ ...envelope, type: z.literal('document.retry'), documentId: z.string().max(128) }),
  z.strictObject({ ...envelope, type: z.literal('document.cancel'), documentId: z.string().max(128) }),
  z.strictObject({ ...envelope, type: z.literal('developer.documents'), scenarioId: z.enum(DOCUMENT_SCENARIO_IDS) }),
  z.strictObject({ ...envelope, type: z.literal('developer.document.import'), fixtureId: z.enum(['assignment-pdf', 'notes-text', 'malformed-pdf', 'scanned-pdf']) }),
  z.strictObject({ ...envelope, type: z.literal('memory.extract') }),
  z.strictObject({ ...envelope, type: z.literal('context.compact') }),
  z.strictObject({ ...envelope, type: z.literal('session.rollover') }),
  z.strictObject({ ...envelope, type: z.literal('developer.memory'), scenarioId: z.enum(['ready', 'failure', 'invalid']) }),
  z.strictObject({ ...envelope, type: z.literal('plugin.enable'), pluginId: z.string().min(1).max(64), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...envelope, type: z.literal('plugin.disable'), pluginId: z.string().min(1).max(64) }),
  z.strictObject({ ...envelope, type: z.literal('plugin.privacy.set'), pluginId: z.string().min(1).max(64), privacy: z.enum(['none', 'optional', 'always']) }),
  z.strictObject({ ...envelope, type: z.literal('developer.set'), enabled: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('developer.clock'), nowMs: z.number().int().min(0).max(8_640_000_000_000_000).optional(), rate: z.number().min(0.01).max(3600).optional(), frozen: z.boolean().optional() }),
  z.strictObject({ ...envelope, type: z.literal('developer.scenario'), scenarioId: z.enum(['empty', 'clock-tool', 'pomodoro-demo']) }),
  z.strictObject({ ...envelope, type: z.literal('developer.mailbox'), scenarioId: z.enum(MAIL_SCENARIO_IDS) }),
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
  let documents: DocumentService | undefined
  let memory: MemoryService | undefined
  let mcp: McpService | undefined
  let backup: BackupService | undefined
  let quill: QuillService | undefined
  let diagnostics: (() => DiagnosticsView) | undefined
  let modelSettings: ModelSettingsService | undefined
  let windows: CompanionWindows | undefined
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
    snapshot.pomodoro = saved.pomodoro
    for (const request of saved.requests.slice(-1000)) requests.set(request.requestId, { signature: request.commandHash,
      ack: { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, epoch: snapshot.epoch, status: 'accepted' } })
  }
  const updatePose = () => { snapshot.companion.pose = { work: 'desk-computer', quiet: 'desk-writing', rest: 'facing-user' }[snapshot.companion.mode] }
  updatePose()
  let execution: { source: 'real' | 'fake'; send(text: string, requestId: string, hash: string): void; stop(id: string): boolean; stateChanged(): void } | undefined
  let executionReady = false
  let runtime: RuntimePort | undefined
  let pomodoro: PomodoroService | undefined
  let timerReady: (() => boolean) | undefined
  let campus: CampusService | undefined
  const readProjection = () => {
    if (!store) return
    const view = store.projection()
    if (snapshot.scope.sessionId !== view.scope.sessionId) { snapshot.epoch = randomUUID(); snapshot.revision = 0; requests.clear(); snapshot.scope = view.scope }
    snapshot.companion.mode = view.mode; snapshot.companion.lightsOut = view.lightsOut
    snapshot.messages = view.messages; snapshot.activities = view.activities; snapshot.task = view.task
    snapshot.pomodoro = pomodoro?.read() ?? view.pomodoro
    updatePose()
  }
  const publish = (reason: AppEvent['reason'], requestId?: string) => {
    snapshot.revision++
    snapshot.clock.nowMs = clock.nowMs()
    if (runtime) { snapshot.runtime = runtime.view(); Object.assign(snapshot.clock, runtime.clockView?.()) }
    if (campus) {
      snapshot.mailbox = campus.view(); snapshot.candidates = campus.candidates(); snapshot.deliveries = campus.deliveries()
      const status = snapshot.mailbox.status
      snapshot.companion.mailboxUnseen = snapshot.mailbox.pendingReviewCount
      snapshot.privacy.mode = 'isolated'
      snapshot.capabilities = snapshot.capabilities.map((item) => item.id === 'mail' ? { id: 'mail', source: snapshot.mailbox!.source,
        status: status === 'blocked' || status === 'failed' ? 'failed' : status === 'disabled' ? 'unavailable' : 'ready', ...(snapshot.mailbox!.error ? { error: snapshot.mailbox!.error } : {}) }
        : item.id === 'privacy' ? { id: 'privacy', source: campus!.privacyStatus() === 'unconfigured' ? 'none' : snapshot.mailbox!.source, status: campus!.privacyStatus() } : item)
    }
    if (documents) {
      snapshot.documents = documents.view()
      snapshot.privacy.fileFilteringEnabled = documents.filteringEnabled()
      snapshot.deliveries = [...(campus?.deliveries() ?? []), ...documents.deliveries()]
    }
    if (memory) {
      snapshot.memory = memory.view(); snapshot.session = memory.sessionView()
      snapshot.capabilities = snapshot.capabilities.map((item) => item.id === 'memory' ? { id: 'memory', source: snapshot.memory!.source,
        status: snapshot.memory!.status === 'unconfigured' ? 'unconfigured' : snapshot.memory!.status === 'failed' ? 'failed' : 'ready', ...(snapshot.memory!.error ? { error: snapshot.memory!.error } : {}) } : item)
    }
    if (pomodoro) {
      snapshot.pomodoro = pomodoro.read()
      snapshot.capabilities = snapshot.capabilities.map((item) => item.id === 'pomodoro' ? { ...item, status: timerReady?.() ? 'ready' : 'unavailable' } : item)
    }
    if (mcp) {
      snapshot.mcp = mcp.view()
      snapshot.capabilities = snapshot.capabilities.map((item) => item.id === 'mcp' ? { id: 'mcp', status: snapshot.mcp!.servers.some((server) => server.status === 'ready') ? 'ready' : snapshot.mcp!.servers.some((server) => server.status === 'connecting') ? 'connecting' : snapshot.mcp!.error || snapshot.mcp!.servers.some((server) => server.status === 'failed') ? 'failed' : 'unconfigured', source: snapshot.mcp!.servers.some((server) => server.source === 'fake') ? 'fake' : snapshot.mcp!.servers.length ? 'real' : 'none' } : item)
    }
    if (backup) {
      snapshot.backup = backup.view()
      snapshot.capabilities = snapshot.capabilities.map((item) => item.id === 'backup' ? { id: 'backup', status: snapshot.backup!.status === 'failed' ? 'failed' : 'ready', source: 'real' } : item)
    }
    if (quill) snapshot.quill = quill.read()
    if (modelSettings) snapshot.modelSettings = modelSettings.view()
    if (windows) snapshot.windows = windows.view()
    snapshot.companion.daypart = deriveDaypart(snapshot.clock.nowMs, daypartSchedule)
    const event: AppEvent = { protocolVersion: PROTOCOL_VERSION, epoch: snapshot.epoch, revision: snapshot.revision,
      occurredAtMs: snapshot.clock.nowMs, type: 'state.snapshot', reason, snapshot: structuredClone(snapshot), ...(requestId ? { requestId } : {}) }
    for (const listener of listeners) listener(event)
  }
  const reject = (requestId: string, code: PublicErrorCode): CommandAck => ({
    protocolVersion: PROTOCOL_VERSION, requestId, epoch: snapshot.epoch, status: 'rejected', error: { code, retryable: false },
  })
  const dispatch = (input: unknown, surface: WindowSurface = 'book'): CommandAck => {
    const parsed = schema.safeParse(input)
    if (!parsed.success) return reject('invalid', 'invalid-command')
    const command: AppCommand = parsed.data
    if (command.epoch !== snapshot.epoch) return reject(command.requestId, 'stale-epoch')
    if ((command.type === 'window.mini.hover' || command.type === 'window.mini.move') && surface !== 'mini') return reject(command.requestId, 'permission-denied')
    const signature = commandHash(command)
    const prior = requests.get(command.requestId)
    if (prior) return prior.signature === signature ? structuredClone(prior.ack) : reject(command.requestId, 'invalid-command')
    if (backup?.isBusy()) return reject(command.requestId, 'unavailable')
    let ack: CommandAck
    if (command.type === 'mode.set') {
      try { store?.append({ type: 'companion/mode', mode: command.mode, requestId: command.requestId, commandHash: signature }) }
      catch { return reject(command.requestId, 'internal') }
      snapshot.companion.mode = command.mode
      pomodoro?.stateChanged(command)
      campus?.stateChanged()
      documents?.stateChanged()
      memory?.stateChanged()
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
      pomodoro?.stateChanged(command)
      campus?.stateChanged()
      documents?.stateChanged()
      memory?.stateChanged()
      runtime?.stateChanged?.(command)
      readProjection()
      updatePose()
      publish('mode', command.requestId)
      execution?.stateChanged()
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (memory && (command.type.startsWith('memory.') || command.type === 'context.compact' || command.type === 'session.rollover' || command.type === 'developer.memory' || command.type === 'message.send' && command.text === '/compact')) {
      try { const error = memory.dispatch(command.type === 'message.send' ? { ...command, type: 'context.compact' } : command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (documents && command.type === 'message.send' && /^\/privacy(?:\s+(?:on|off))?$/i.test(command.text)) {
      const value = command.text.trim().split(/\s+/)[1]?.toLowerCase()
      try { const error = documents.dispatch({ ...command, type: 'privacy.set', enabled: value ? value === 'on' : !documents.filteringEnabled() }); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('connection', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (documents && (command.type === 'privacy.set' || command.type.startsWith('document.') || command.type === 'developer.documents' || command.type === 'developer.document.import' || (command.type === 'artifact.open' && documents.ownsArtifact(command.artifactId)))) {
      try { const error = command.type === 'artifact.open' ? documents.openArtifact(command.artifactId) : documents.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (windows && command.type.startsWith('window.')) {
      try { const error = windows.dispatch(command, surface); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('mode', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (modelSettings && command.type === 'models.configure') {
      try { const error = modelSettings.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('connection', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (backup && command.type.startsWith('backup.')) {
      try { const error = backup.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (mcp && command.type.startsWith('mcp.')) {
      try { const error = mcp.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('connection', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (command.type === 'message.send' && execution && executionReady && !snapshot.companion.lightsOut) {
      try { execution.send(command.text, command.requestId, signature) }
      catch { return reject(command.requestId, 'internal') }
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (command.type === 'turn.stop' && execution) {
      if (!execution.stop(command.taskId)) return reject(command.requestId, 'invalid-command')
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (campus && (command.type.startsWith('candidate.') || command.type === 'mail.scan' || command.type === 'campus.export' || command.type === 'artifact.open' || command.type === 'developer.mailbox')) {
      try {
        const error = campus.dispatch(command)
        ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
        publish('task', command.requestId)
      } catch { ack = reject(command.requestId, 'internal') }
    } else if (pomodoro && command.type.startsWith('pomodoro.')) {
      try {
        const error = timerReady?.() ? pomodoro.dispatch(command) : 'unavailable'
        ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
        readProjection(); publish('timer', command.requestId)
      } catch { ack = reject(command.requestId, 'internal') }
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
    attachCampus: (port: CampusService) => { campus = port; publish('connection') },
    attachDocuments: (port: DocumentService) => { documents = port; publish('connection') },
    attachMemory: (port: MemoryService) => { memory = port; publish('connection') },
    attachMcp: (port: McpService) => { mcp = port; publish('connection') },
    attachBackup: (port: BackupService) => { backup = port; publish('connection') },
    attachQuill: (port: QuillService) => { quill = port; publish('connection') },
    attachModelSettings: (port: ModelSettingsService) => { modelSettings = port; publish('connection') },
    attachWindows: (port: CompanionWindows) => { windows = port; publish('mode') },
    attachDiagnostics: (read: () => DiagnosticsView) => { diagnostics = read },
    readDiagnostics: () => { if (runtime?.view().developer.mode !== 'developer' || !diagnostics) throw new Error('DIAGNOSTICS_UNAVAILABLE'); return diagnostics() },
    readSession: (id: unknown) => {
      if (!memory || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('SESSION_UNAVAILABLE')
      try { return memory.readSession(id) } catch { throw new Error('SESSION_UNAVAILABLE') }
    },
    importUserFiles: (input: unknown): FileImportAck => {
      if (backup?.isBusy()) return { acceptedIds: [], rejectedCount: 1, error: { code: 'unavailable', retryable: true } }
      const parsed = z.strictObject({ epoch: z.string().max(128), paths: z.array(z.string().min(1).max(4096)).min(1).max(5) }).safeParse(input)
      if (!parsed.success) return { acceptedIds: [], rejectedCount: 1, error: { code: 'invalid-command', retryable: false } }
      if (parsed.data.epoch !== snapshot.epoch) return { acceptedIds: [], rejectedCount: parsed.data.paths.length, error: { code: 'stale-epoch', retryable: false } }
      if (!documents) return { acceptedIds: [], rejectedCount: parsed.data.paths.length, error: { code: 'unavailable', retryable: false } }
      return documents.importPaths(parsed.data.paths)
    },
    attachPomodoro: (port: PomodoroService, ready: () => boolean) => {
      pomodoro = port; timerReady = ready
      snapshot.capabilities = snapshot.capabilities.map((item) => item.id === 'pomodoro' ? { id: 'pomodoro', status: 'ready', source: 'real' } : item)
      readProjection(); publish('connection')
    },
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

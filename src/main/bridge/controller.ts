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
import type { ProjectsService } from '../dsh/projects'
import type { CompanionWindows, WindowSurface } from '../windows/companion'
import { characterNameInput, initialOnboarding, onboardingView, userNameInput } from '../onboarding/schema'
import { giftSpecSchema } from '../gifts/schema'
import type { GiftService } from '../gifts/service'
import type { LegacyFlowRecords } from '../legacy-flow/records'
import type { AttentionService } from '../attention/service'
import type { VoiceService } from '../voice/service'
import type { LifeService } from '../life/service'
import type { SleepService } from '../life/sleep'
import type { LifeWorkService } from '../life/work/service'
import type { DiaryService } from '../diary/service'
import type { NotificationsService } from '../notifications/service'
import { notificationRuleInput } from '../notifications/schema'
import type { CharacterService } from '../characters/service'
import type { HistoryPhotos } from '../history/photos'
import type { HistoryRecall } from '../history/recall'
import { recallAnchorSchema } from '../history/schema'
import type { OpticalMemoryService } from '../optical/service'
import { opticalTier } from '../optical/schema'
import { minecraftScopeSchema, type MinecraftService } from '../minecraft/service'
import type { MinecraftChat } from '../minecraft/chat'
import type { ResourceBudget } from '../resources/service'
import type { QuestionService } from '../questions/service'
import { answerInput, answersInput } from '../questions/schema'

const envelope = { protocolVersion: z.literal(PROTOCOL_VERSION), requestId: z.string().min(1).max(128), epoch: z.string().min(1).max(128) }
const schema = z.discriminatedUnion('type', [
  // An approval's choice (`answer`) or her questions' answers (`answers`), never both; questions/service.ts checks them against the question.
  z.strictObject({ ...envelope, type: z.literal('question.answer'), questionId: z.string().uuid(), answer: answerInput.optional(), answers: answersInput.optional() })
    .refine((command) => (command.answer === undefined) !== (command.answers === undefined)),
  z.strictObject({ ...envelope, type: z.literal('question.dismiss'), questionId: z.string().uuid() }),
  z.strictObject({ ...envelope, type: z.literal('project.pick') }),
  z.strictObject({ ...envelope, type: z.literal('project.select'), path: z.string().min(1).max(1024) }),
  z.strictObject({ ...envelope, type: z.literal('project.forget'), path: z.string().min(1).max(1024) }),
  z.strictObject({ ...envelope, type: z.literal('project.untrust'), path: z.string().min(1).max(1024) }),
  z.strictObject({ ...envelope, type: z.literal('companion.sleep'), sleeping: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('voice.set'), enabled: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('resources.configure'), dailyTotalUnits: z.number().int().min(10000).max(5_000_000), dailyAutonomousUnits: z.number().int().nonnegative().max(5_000_000) }).refine((value) => value.dailyAutonomousUnits <= value.dailyTotalUnits),
  z.strictObject({ ...envelope, type: z.literal('voice.stop'), utteranceId: z.string().uuid() }),
  z.strictObject({ ...envelope, type: z.literal('voice.playback'), utteranceId: z.string().uuid(), status: z.enum(['playing', 'ended', 'failed']) }),
  z.strictObject({ ...envelope, type: z.literal('minecraft.check'), serverId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('minecraft.start'), serverId: z.string().min(1).max(128), expectedPlayerUuid: z.string().uuid(), scope: minecraftScopeSchema }),
  z.strictObject({ ...envelope, type: z.literal('minecraft.stop') }),
  z.strictObject({ ...envelope, type: z.literal('developer.minecraft'), scenario: z.enum(['ready', 'chat', 'world-change', 'unsafe', 'unreachable']) }),
  z.strictObject({ ...envelope, type: z.literal('optical.configure') }),
  z.strictObject({ ...envelope, type: z.literal('optical.enable'), enabled: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('optical.encode'), sessionId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('optical.decode'), frameId: z.string().regex(/^[a-f0-9]{64}$/), tier: opticalTier }),
  z.strictObject({ ...envelope, type: z.literal('developer.life.seed') }),
  z.strictObject({ ...envelope, type: z.literal('life.work.start'), kind: z.enum(['read', 'write']) }),
  z.strictObject({ ...envelope, type: z.literal('life.work.pause'), workId: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...envelope, type: z.literal('life.work.resume'), workId: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...envelope, type: z.literal('life.work.open'), workId: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...envelope, type: z.literal('history.photo.capture') }),
  z.strictObject({ ...envelope, type: z.literal('history.recall'), anchor: recallAnchorSchema, question: z.string().trim().min(1).max(4000) }),
  z.strictObject({ ...envelope, type: z.literal('character.import') }),
  z.strictObject({ ...envelope, type: z.literal('character.export') }),
  z.strictObject({ ...envelope, type: z.literal('character.select'), characterId: z.string().regex(/^(?:default-character|character:[a-f0-9]{64})$/) }),
  z.strictObject({ ...envelope, type: z.literal('notification.rule.add'), ...notificationRuleInput.shape }),
  z.strictObject({ ...envelope, type: z.literal('notification.rule.remove'), ruleId: z.string().uuid() }),
  z.strictObject({ ...envelope, type: z.literal('notification.rule.confirm'), ruleId: z.string().uuid() }),
  z.strictObject({ ...envelope, type: z.literal('notification.rule.discard'), ruleId: z.string().uuid() }),
  z.strictObject({ ...envelope, type: z.literal('diary.write') }),
  z.strictObject({ ...envelope, type: z.literal('room.open') }),
  z.strictObject({ ...envelope, type: z.literal('room.rebuild') }),
  z.strictObject({ ...envelope, type: z.literal('life.schedule'), schedule: z.enum(['auto', 'work', 'rest']) }),
  z.strictObject({ ...envelope, type: z.literal('life.propose'), place: z.enum(['coast', 'swing']).optional() }),
  z.strictObject({ ...envelope, type: z.literal('life.depart'), outingId: z.string().max(100) }),
  z.strictObject({ ...envelope, type: z.literal('life.return') }),
  z.strictObject({ ...envelope, type: z.literal('context.reveal'), source: z.literal('mail'), ref: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('message.send'), text: z.string().trim().min(1).max(20_000) }),
  z.strictObject({ ...envelope, type: z.literal('turn.stop'), taskId: z.string().min(1).max(128) }),
  z.strictObject({ ...envelope, type: z.literal('mode.set'), mode: z.enum(['work', 'quiet', 'rest']) }),
  z.strictObject({ ...envelope, type: z.literal('lights.set'), lightsOut: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('onboarding.profile'), userName: userNameInput.optional(), characterName: characterNameInput.optional() }).refine((value) => value.userName !== undefined || value.characterName !== undefined),
  z.strictObject({ ...envelope, type: z.literal('onboarding.complete') }),
  z.strictObject({ ...envelope, type: z.literal('onboarding.reset') }),
  z.strictObject({ ...envelope, type: z.literal('gift.propose'), ...giftSpecSchema.shape }),
  z.strictObject({ ...envelope, type: z.literal('gift.accept'), giftId: z.string().uuid() }),
  z.strictObject({ ...envelope, type: z.literal('gift.start'), giftId: z.string().uuid() }),
  z.strictObject({ ...envelope, type: z.literal('gift.cancel'), giftId: z.string().uuid() }),
  z.strictObject({ ...envelope, type: z.literal('gift.open'), giftId: z.string().uuid() }),
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
  z.strictObject({ ...envelope, type: z.literal('mcp.configure.path'), path: z.string().min(1).max(4096) }),
  z.strictObject({ ...envelope, type: z.literal('mcp.connect'), serverId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...envelope, type: z.literal('mcp.disconnect'), serverId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/) }),
  z.strictObject({ ...envelope, type: z.literal('models.configure') }),
  z.strictObject({ ...envelope, type: z.literal('models.provider.save'), slot: z.enum(['chat', 'work', 'background', 'chat_google', 'chat_claude', 'privacy']), baseUrl: z.string().max(4096).default(''), model: z.string().max(256).default(''), apiKey: z.string().max(8192).optional() }),
  z.strictObject({ ...envelope, type: z.literal('models.provider.remove'), slot: z.enum(['chat', 'work', 'background', 'chat_google', 'chat_claude', 'privacy']) }),
  z.strictObject({ ...envelope, type: z.literal('models.routing.set'), slot: z.enum(['background', 'privacy', 'work']), mode: z.enum(['follow-main', 'independent']) }),
  z.strictObject({ ...envelope, type: z.literal('models.effort.set'), role: z.enum(['chat', 'work']), effort: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable() }),
  z.strictObject({ ...envelope, type: z.literal('models.probe'), slot: z.enum(['chat', 'work', 'background', 'chat_google', 'chat_claude', 'privacy']) }),
  z.strictObject({ ...envelope, type: z.literal('models.service.save'), service: z.enum(['tts', 'rodin']), baseUrl: z.string().max(4096).default(''), model: z.string().max(256).default(''), apiKey: z.string().max(8192).optional(), voice: z.string().max(256).optional() }),
  z.strictObject({ ...envelope, type: z.literal('mail.configure'), host: z.string().max(256).default(''), port: z.number().int().min(1).max(65535).optional(), user: z.string().max(320).default(''), authCode: z.string().max(8192).optional() }),
  z.strictObject({ ...envelope, type: z.literal('window.mini') }),
  z.strictObject({ ...envelope, type: z.literal('window.expand') }),
  z.strictObject({ ...envelope, type: z.literal('window.book') }),
  z.strictObject({ ...envelope, type: z.literal('window.mini.hover'), over: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('window.mini.move'), dx: z.number().int().min(-10000).max(10000), dy: z.number().int().min(-10000).max(10000) }),
  z.strictObject({ ...envelope, type: z.literal('window.mini.moveBy'), dx: z.number().int().min(-10000).max(10000), dy: z.number().int().min(-10000).max(10000) }),
  z.strictObject({ ...envelope, type: z.literal('window.diagnostics.open') }),
  z.strictObject({ ...envelope, type: z.literal('privacy.set'), enabled: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('document.attachment'), attachmentId: z.string().max(128) }),
  z.strictObject({ ...envelope, type: z.literal('document.retry'), documentId: z.string().max(128) }),
  z.strictObject({ ...envelope, type: z.literal('document.cancel'), documentId: z.string().max(128) }),
  z.strictObject({ ...envelope, type: z.literal('developer.documents'), scenarioId: z.enum(DOCUMENT_SCENARIO_IDS) }),
  z.strictObject({ ...envelope, type: z.literal('developer.document.import'), fixtureId: z.enum(['assignment-pdf', 'notes-text', 'malformed-pdf', 'scanned-pdf']) }),
  z.strictObject({ ...envelope, type: z.literal('memory.extract') }),
  z.strictObject({ ...envelope, type: z.literal('memory.consolidate') }),
  z.strictObject({ ...envelope, type: z.literal('context.compact') }),
  z.strictObject({ ...envelope, type: z.literal('session.rollover') }),
  z.strictObject({ ...envelope, type: z.literal('developer.memory'), scenarioId: z.enum(['ready', 'failure', 'invalid']) }),
  z.strictObject({ ...envelope, type: z.literal('plugin.install'), path: z.string().min(1).max(4096) }),
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

export function createAppController(clock: Clock, daypartSchedule?: DaypartSchedule, store?: SessionStore, options: { booth?: boolean } = {}) {
  const listeners = new Set<(event: AppEvent) => void>()
  let documents: DocumentService | undefined
  let memory: MemoryService | undefined
  let mcp: McpService | undefined
  let backup: BackupService | undefined
  let quill: QuillService | undefined
  let diagnostics: (() => DiagnosticsView) | undefined
  let modelSettings: ModelSettingsService | undefined
  let projects: ProjectsService | undefined
  let windows: CompanionWindows | undefined
  let gifts: GiftService | undefined
  let legacyFlows: LegacyFlowRecords | undefined
  let attention: AttentionService | undefined
  let revealContext: ((command: Extract<AppCommand, { type: 'context.reveal' }>, signature: string) => PublicErrorCode | undefined) | undefined
  let voice: VoiceService | undefined
  let resources: ResourceBudget | undefined
  let questions: QuestionService | undefined
  let life: LifeService | undefined
  let sleep: SleepService | undefined
  let lifeWork: LifeWorkService | undefined
  let diary: DiaryService | undefined
  let notifications: NotificationsService | undefined
  let character: CharacterService | undefined
  let photos: HistoryPhotos | undefined
  let recall: HistoryRecall | undefined
  let optical: OpticalMemoryService | undefined
  let minecraft: MinecraftService | undefined
  let minecraftChat: MinecraftChat | undefined
  let gameScenario: ((scenario: Extract<AppCommand, { type: 'developer.minecraft' }>['scenario']) => void) | undefined
  let room: { open(): void; rebuild(): void } | undefined
  const requests = new Map<string, { signature: string; ack: CommandAck }>()
  const snapshot: AppSnapshot = {
    protocolVersion: PROTOCOL_VERSION, epoch: randomUUID(), revision: 0, onboarding: onboardingView(store?.projection().onboarding ?? initialOnboarding(), !!options.booth),
    scope: { userId: 'local-user', characterId: 'default-character', sessionId: randomUUID() },
    clock: { nowMs: clock.nowMs(), timeZone: 'Asia/Shanghai', rate: 1, frozen: false },
    companion: { mode: 'rest', lightsOut: false, locationId: 'room', pose: 'facing-user', expression: DEFAULT_EXPRESSION,
      daypart: deriveDaypart(clock.nowMs(), daypartSchedule), mailboxUnseen: 0 },
    pomodoro: { phase: 'idle', status: 'idle', remainingMs: 0, endsAtMs: null, focusIndex: 0, phaseDurationMs: 0, plannedCount: 0 },
    task: null, messages: [], activities: [], candidates: [], deliveries: [],
    capabilities: (['chat', 'pomodoro', 'mail', 'privacy', 'memory', 'backup', 'mcp', 'rodin'] as const).map((id) => ({
      id, status: 'unavailable' as const, source: 'none' as const,
    })),
    privacy: { mode: 'follow-main', fileFilteringEnabled: false },
  }
  if (store) {
    const saved = store.projection()
    snapshot.scope = saved.scope
    snapshot.companion.mode = saved.mode
    snapshot.companion.lightsOut = saved.lightsOut
    snapshot.companion.sleeping = saved.sleeping
    snapshot.messages = saved.messages
    snapshot.activities = saved.activities
    snapshot.task = saved.task
    if (saved.degraded) snapshot.degraded = saved.degraded
    snapshot.pomodoro = saved.pomodoro
    for (const request of saved.requests.slice(-1000)) requests.set(request.requestId, { signature: request.commandHash,
      ack: { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, epoch: snapshot.epoch, status: 'accepted' } })
  }
  const updatePose = () => { snapshot.companion.pose = attention?.view().pose ?? (snapshot.companion.sleeping ? 'sleeping' : { work: 'desk-computer', quiet: 'desk-writing', rest: 'facing-user' }[snapshot.companion.mode]) }
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
    snapshot.companion.mode = view.mode; snapshot.companion.lightsOut = view.lightsOut; snapshot.companion.sleeping = view.sleeping
    snapshot.onboarding = onboardingView(view.onboarding, !!options.booth)
    snapshot.messages = view.messages; snapshot.activities = view.activities; snapshot.task = view.task
    if (view.degraded) snapshot.degraded = view.degraded; else delete snapshot.degraded
    snapshot.pomodoro = pomodoro?.read() ?? view.pomodoro
    updatePose()
  }
  const publish = (reason: AppEvent['reason'], requestId?: string) => {
    snapshot.revision++
    snapshot.clock.nowMs = clock.nowMs()
    if (attention) { snapshot.attention = attention.view(); updatePose() }
    if (runtime) { snapshot.runtime = runtime.view(); Object.assign(snapshot.clock, runtime.clockView?.()) }
    if (campus) {
      snapshot.mailbox = campus.view(); snapshot.candidates = campus.candidates(); snapshot.deliveries = campus.deliveries()
      const status = snapshot.mailbox.status
      snapshot.companion.mailboxUnseen = snapshot.mailbox.pendingReviewCount
      snapshot.privacy.mode = campus.privacyMode()
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
    if (gifts) { snapshot.gifts = gifts.view(); snapshot.capabilities = snapshot.capabilities.map((item) => item.id === 'rodin' ? { ...item, status: snapshot.gifts!.configured ? 'ready' : 'unconfigured', source: snapshot.gifts!.items.at(-1)?.source ?? 'none' } : item) }
    if (legacyFlows) { const sessions = legacyFlows.sessions(); if (sessions.length) snapshot.legacyFlows = sessions }
    if (life) { snapshot.life = life.view(); snapshot.companion.locationId = snapshot.life.locationId }
    if (diary) snapshot.diary = diary.view()
    if (notifications) snapshot.notifications = notifications.view()
    if (character) snapshot.characterPack = character.view()
    if (photos) snapshot.history = { ...photos.view(), recall: recall?.view() ?? { status: 'idle' } }
    if (optical) snapshot.opticalMemory = optical.view()
    if (voice) snapshot.voice = voice.view()
    if (resources) snapshot.resources = resources.view()
    const question = questions?.view(); if (question) snapshot.question = question; else delete snapshot.question
    if (minecraft) {
      snapshot.minecraft = minecraft.view()
      if (minecraft.active() && minecraftChat) { const game = minecraftChat.view(); snapshot.messages = [...game.messages]; snapshot.activities = [...game.activities]; snapshot.task = game.task }
    }
    if (modelSettings) snapshot.modelSettings = modelSettings.view()
    if (projects) snapshot.work = projects.view(); else delete snapshot.work
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
    // The schema checks each command's shape; an answer's two forms are told apart by the field it has.
    const command = parsed.data as AppCommand
    if (command.epoch !== snapshot.epoch) return reject(command.requestId, 'stale-epoch')
    if (surface === 'diagnostics' || (command.type === 'window.mini.hover' || command.type === 'window.mini.move' || command.type === 'window.mini.moveBy') && surface !== 'mini') return reject(command.requestId, 'permission-denied')
    if (command.type.startsWith('onboarding.') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type === 'context.reveal' && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type.startsWith('voice.') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type.startsWith('resources.') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type.startsWith('question.') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type.startsWith('project.') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type === 'companion.sleep' && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if ((command.type.startsWith('room.') || command.type === 'diary.write') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type.startsWith('notification.') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type.startsWith('character.') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type.startsWith('history.') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type.startsWith('optical.') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if ((command.type.startsWith('minecraft.') || command.type === 'developer.minecraft') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if ((command.type.startsWith('life.work.') || command.type === 'developer.life.seed') && surface !== 'book') return reject(command.requestId, 'permission-denied')
    if (command.type === 'onboarding.reset' && options.booth) return reject(command.requestId, 'permission-denied')
    const signature = commandHash(command)
    const prior = requests.get(command.requestId)
    if (prior) return prior.signature === signature ? structuredClone(prior.ack) : reject(command.requestId, 'invalid-command')
    if (backup?.isBusy() || modelSettings?.isBusy() && !command.type.startsWith('window.') && !['turn.stop', 'lights.set'].includes(command.type)) return reject(command.requestId, 'unavailable')
    if (minecraft?.active() && !['message.send', 'turn.stop', 'lights.set', 'mode.set', 'mcp.disconnect', 'developer.minecraft'].includes(command.type)
      && !command.type.startsWith('minecraft.') && !command.type.startsWith('window.') && !command.type.startsWith('pomodoro.')) return reject(command.requestId, 'unavailable')
    let ack: CommandAck
    // A deliberate conversation/work request is user presence. Window telemetry and
    // background ticks do not wake her; lights remain an independent pause switch.
    if (!snapshot.companion.lightsOut && (['message.send', 'history.recall', 'pomodoro.start', 'pomodoro.resume', 'life.work.start', 'life.work.resume', 'minecraft.start', 'life.depart'].includes(command.type)
      || command.type === 'mode.set' && command.mode !== 'rest' || command.type === 'life.schedule' && command.schedule === 'work')) sleep?.wake()
    if (command.type === 'companion.sleep' && sleep) {
      const error = sleep.set(command.sleeping, 'user', { requestId: command.requestId, commandHash: signature }); readProjection()
      ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
      publish('mode', command.requestId); execution?.stateChanged()
    } else if (command.type.startsWith('question.') && questions) {
      const error = questions.dispatch(command, signature); readProjection()
      ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId)
    } else if (command.type === 'resources.configure' && resources) {
      const error = resources.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('connection', command.requestId)
    } else if (command.type.startsWith('voice.') && voice) {
      const error = voice.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('connection', command.requestId)
    } else if (command.type.startsWith('minecraft.') && minecraft) {
      const error = command.type === 'minecraft.start' && !minecraftChat?.ready() ? 'not-configured' : minecraft.dispatch(command)
      ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId)
    } else if (command.type === 'developer.minecraft') {
      if (!gameScenario) return reject(command.requestId, 'permission-denied'); gameScenario(command.scenario); minecraft?.stateChanged()
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId)
    } else if (minecraft?.active() && command.type === 'message.send') {
      if (!minecraftChat || minecraft.view().status !== 'playing' || surface !== 'book') return reject(command.requestId, 'unavailable')
      try { minecraftChat.send(command.text, command.requestId, signature) } catch { return reject(command.requestId, 'unavailable') }
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (minecraft?.active() && command.type === 'turn.stop') {
      if (!minecraftChat?.stop(command.taskId)) return reject(command.requestId, 'invalid-command'); void minecraft.stop()
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (command.type === 'onboarding.profile' || command.type === 'onboarding.complete' || command.type === 'onboarding.reset') {
      const current = snapshot.onboarding ?? initialOnboarding()
      const view = command.type === 'onboarding.profile' ? { ...current,
        ...(command.userName !== undefined ? { userName: command.userName || null } : {}), ...(command.characterName !== undefined ? { characterName: command.characterName || '桃子' } : {}) }
        : command.type === 'onboarding.complete' ? { ...current, status: 'completed' as const, completedAtMs: current.status === 'completed' ? current.completedAtMs : clock.nowMs() }
          : { ...current, status: 'needed' as const, completedAtMs: null }
      try { store?.append({ type: 'onboarding/state', view, cause: command.type === 'onboarding.profile' ? 'profile' : command.type === 'onboarding.complete' ? 'completed' : 'reset', requestId: command.requestId, commandHash: signature }) }
      catch { return reject(command.requestId, 'internal') }
      snapshot.onboarding = onboardingView(view, !!options.booth)
      publish('connection', command.requestId)
      ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
    } else if (command.type === 'mode.set') {
      try { store?.append({ type: 'companion/mode', mode: command.mode, requestId: command.requestId, commandHash: signature }) }
      catch { return reject(command.requestId, 'internal') }
      snapshot.companion.mode = command.mode
      lifeWork?.foreground()
      life?.reconcile()
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
      optical?.foreground()
      lifeWork?.foreground()
      life?.reconcile()
      gifts?.stateChanged()
      diary?.foreground()
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
    } else if (optical && command.type.startsWith('optical.')) {
      try { const error = optical.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (revealContext && command.type === 'context.reveal') {
      const error = revealContext(command, signature)
      ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }
      publish('task', command.requestId)
    } else if (recall && command.type === 'history.recall') {
      const error = recall.request(command.anchor, command.question, command.requestId, signature); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId)
    } else if (photos && command.type === 'history.photo.capture') {
      const error = photos.capture(); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId)
    } else if (character && command.type.startsWith('character.')) {
      const error = character.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('connection', command.requestId)
    } else if (notifications && command.type.startsWith('notification.')) {
      const error = notifications.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('connection', command.requestId)
    } else if (diary && command.type === 'diary.write') {
      const error = diary.canWrite(); if (!error) void diary.write(true); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId)
    } else if (room && (command.type === 'room.open' || command.type === 'room.rebuild')) {
      try { if (command.type === 'room.open') room.open(); else room.rebuild(); ack = { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' } } catch { ack = reject(command.requestId, 'internal') }
    } else if (lifeWork && (command.type.startsWith('life.work.') || command.type === 'developer.life.seed')) {
      try { const error = lifeWork.dispatch(command); life?.reconcile(); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (life && command.type.startsWith('life.')) {
      lifeWork?.foreground()
      const error = life.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('mode', command.requestId)
    } else if (gifts && command.type.startsWith('gift.')) {
      try { const error = gifts.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (windows && command.type.startsWith('window.')) {
      try { const error = windows.dispatch(command, surface); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('mode', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (projects && command.type.startsWith('project.')) {
      try { const error = projects.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (modelSettings && (command.type.startsWith('models.') || command.type === 'mail.configure')) {
      try { const error = modelSettings.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('connection', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (backup && command.type.startsWith('backup.')) {
      try { const error = backup.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('task', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (mcp && command.type.startsWith('mcp.')) {
      try { const error = mcp.dispatch(command); ack = error ? reject(command.requestId, error) : { protocolVersion: PROTOCOL_VERSION, requestId: command.requestId, epoch: snapshot.epoch, status: 'accepted' }; publish('connection', command.requestId) }
      catch { ack = reject(command.requestId, 'internal') }
    } else if (command.type === 'message.send' && execution && executionReady && !snapshot.companion.lightsOut) {
      try { voice?.interrupt(); execution.send(command.text, command.requestId, signature) }
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
    minecraft?.stateChanged()
    voice?.stateChanged()
    questions?.stateChanged()
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
    attachResources: (port: ResourceBudget) => { resources = port; publish('connection') },
    attachQuestions: (port: QuestionService) => { questions = port; publish('task') },
    attachCampus: (port: CampusService) => { campus = port; publish('connection') },
    attachDocuments: (port: DocumentService) => { documents = port; publish('connection') },
    attachMemory: (port: MemoryService) => { memory = port; publish('connection') },
    attachMcp: (port: McpService) => { mcp = port; publish('connection') },
    attachMinecraft: (port: MinecraftService, chat: MinecraftChat, scenario?: typeof gameScenario) => { minecraft = port; minecraftChat = chat; gameScenario = scenario; publish('connection') },
    attachBackup: (port: BackupService) => { backup = port; publish('connection') },
    attachQuill: (port: QuillService) => { quill = port; publish('connection') },
    attachGifts: (port: GiftService) => { gifts = port; publish('connection') },
    attachLegacyFlows: (port: LegacyFlowRecords) => { legacyFlows = port; publish('connection') },
    attachAttention: (port: AttentionService) => { attention = port; snapshot.attention = attention.view(); updatePose(); publish('mode') },
    attachContextReveal: (port: NonNullable<typeof revealContext>) => { revealContext = port },
    attachVoice: (port: VoiceService) => { voice = port; publish('connection') },
    readVoice: (input: unknown) => { if (!voice || backup?.isBusy()) throw new Error('VOICE_UNAVAILABLE'); return voice.read(input) },
    attachLife: (port: LifeService) => { life = port; publish('mode') },
    attachSleep: (port: SleepService) => { sleep = port },
    attachLifeWork: (port: LifeWorkService) => { lifeWork = port },
    attachDiary: (port: DiaryService, roomPort: NonNullable<typeof room>) => { diary = port; room = roomPort; publish('connection') },
    attachNotifications: (port: NotificationsService) => { notifications = port; publish('connection') },
    attachCharacter: (port: CharacterService) => { character = port; publish('connection') },
    attachPhotos: (port: HistoryPhotos) => { photos = port; publish('connection') },
    attachRecall: (port: HistoryRecall) => { recall = port; publish('connection') },
    attachOptical: (port: OpticalMemoryService) => { optical = port; publish('connection') },
    readOpticalMemory: (id: unknown) => { if (!optical || typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || backup?.isBusy()) throw new Error('OPTICAL_UNAVAILABLE'); return optical.read(id) },
    readDiary: (id: unknown) => { if (!diary || typeof id !== 'string' || !/^diary:[a-f0-9]{64}$/.test(id)) throw new Error('DIARY_UNAVAILABLE'); return diary.read(id) },
    readHeartFlow: (input: unknown) => { const parsed = z.strictObject({ section: z.enum(['status', 'permissions', 'diff']), flowId: z.string().min(1).max(128) }).parse(input); if (!legacyFlows) throw new Error('FLOW_UNAVAILABLE'); return legacyFlows.inspect(parsed) },
    attachModelSettings: (port: ModelSettingsService) => { modelSettings = port; publish('connection') },
    attachProjects: (port: ProjectsService) => { projects = port; publish('task') },
    attachWindows: (port: CompanionWindows) => { windows = port; publish('mode') },
    attachDiagnostics: (read: () => DiagnosticsView) => { diagnostics = read },
    readDiagnostics: () => { if (runtime?.view().developer.mode !== 'developer' || !diagnostics) throw new Error('DIAGNOSTICS_UNAVAILABLE'); return diagnostics() },
    readSession: (id: unknown) => {
      if (!memory || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('SESSION_UNAVAILABLE')
      try { return { ...memory.readSession(id), recallableMessageIds: recall?.recallable(id) ?? [], ...(photos?.photo(id) ? { photo: photos.photo(id) } : {}) } } catch { throw new Error('SESSION_UNAVAILABLE') }
    },
    importUserFiles: (input: unknown): FileImportAck => {
      if (backup?.isBusy() || modelSettings?.isBusy()) return { acceptedIds: [], rejectedCount: 1, error: { code: 'unavailable', retryable: true } }
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

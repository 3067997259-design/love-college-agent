import type { DocumentScenarioId, GiftMotif, GiftObjectId, MailScenarioId, MinecraftScope, ModelProviderSlot, OpticalTier, PomodoroPlanInput, PublicError, QuestionAnswer, ReasoningEffort, RecallAnchor } from './state'

interface CommandEnvelope {
  protocolVersion: 1
  requestId: string
  epoch: string
}
/** Only main decides availability and permission. Undeveloped operations reject explicitly. */
export type AppCommand = CommandEnvelope & (
  | { type: 'message.send'; text: string }
  | { type: 'turn.stop'; taskId: string }
  | { type: 'voice.set'; enabled: boolean }
  /** Booth book only. Integer reservations: total 10000..5000000, autonomous 0..total.
   * A reduction never refunds prior admissions; it only gates subsequent requests. */
  | { type: 'resources.configure'; dailyTotalUnits: number; dailyAutonomousUnits: number }
  /**
   * Book-only answer to the current visible question. Information, never an execution grant. An approval takes one
   * of its choices as `answer`; her questions take `answers`, one per question in order, at least one not skipped.
   */
  | { type: 'question.answer'; questionId: string; answer: string }
  | { type: 'question.answer'; questionId: string; answers: readonly QuestionAnswer[] }
  | { type: 'question.dismiss'; questionId: string }
  /** Book only. Main opens the folder dialog; `select` takes her desk or a recent project, never a typed path. */
  | { type: 'project.pick' }
  | { type: 'project.select'; path: string }
  | { type: 'project.forget'; path: string }
  /** Withdraw trust from the current project: back to the OS sandbox, approvals ask again. */
  | { type: 'project.untrust'; path: string }
  | { type: 'voice.stop'; utteranceId: string }
  /** Book playback reports only; this is renderer telemetry, not synthesis or external-action evidence. */
  | { type: 'voice.playback'; utteranceId: string; status: 'playing' | 'ended' | 'failed' }
  | { type: 'mode.set'; mode: 'work' | 'quiet' | 'rest' }
  | { type: 'companion.sleep'; sleeping: boolean }
  | { type: 'lights.set'; lightsOut: boolean }
  /** Trimmed single-line text: userName <= 20 code points, characterName <= 12. Empty resets to null / 桃子. */
  | { type: 'onboarding.profile'; userName?: string; characterName?: string }
  | { type: 'onboarding.complete' }
  /** Reopen initialization; retain names and all private business/history data. Refused in booth mode. */
  | { type: 'onboarding.reset' }
  /** Only an existing, witnessed experience may anchor a generated gift. Object descriptions are enum-derived. */
  | { type: 'gift.propose'; sourceMemoryId: string; objectId: GiftObjectId; motif: GiftMotif }
  /** User accepts the offer; generation still waits for focus. */
  | { type: 'gift.accept'; giftId: string }
  | { type: 'gift.start'; giftId: string }
  | { type: 'gift.cancel'; giftId: string }
  | { type: 'gift.open'; giftId: string }
  | { type: 'pomodoro.start'; planId: string }
  | { type: 'pomodoro.plan'; plan: PomodoroPlanInput }
  | { type: 'pomodoro.confirm'; planId: string }
  | { type: 'pomodoro.discard'; planId: string }
  | { type: 'pomodoro.resume' }
  | { type: 'pomodoro.pause' }
  | { type: 'pomodoro.stop' }
  | { type: 'mail.scan' }
  /** Real candidate mutations require the rendered revision; omissions reject at runtime. */
  | { type: 'candidate.confirm'; candidateId: string; expectedRevision?: number; plannedCompletionIso?: string | null }
  | { type: 'candidate.ignore'; candidateId: string; expectedRevision?: number }
  | { type: 'campus.export' }
  | { type: 'artifact.open'; artifactId: string }
  | { type: 'backup.export' }
  | { type: 'backup.import' }
  /** Confirm only after native file selection, validation and the incoming summary are shown. */
  | { type: 'backup.restore'; restoreId: string }
  | { type: 'backup.cancel' }
  /** Native file chooser; configuration and credentials never pass through the renderer. */
  | { type: 'mcp.configure' }
  /** Main reads this local MCP JSON path; contents and credentials never return to the renderer. */
  | { type: 'mcp.configure.path'; path: string }
  | { type: 'mcp.connect'; serverId: string; fingerprint: string }
  | { type: 'mcp.disconnect'; serverId: string }
  /** Inspect an already human-connected endpoint. ListTools alone never grants game control. */
  | { type: 'minecraft.check'; serverId: string }
  /** Book user accepts this observed pilot and bounded round. No administrator/world-write tools. */
  | { type: 'minecraft.start'; serverId: string; expectedPlayerUuid: string; scope: MinecraftScope }
  /** Invalidate this round, release its input owner and verify. No automatic restart after focus/lights/relaunch. */
  | { type: 'minecraft.stop' }
  /** Owned development fixture only. Never manipulates a running Minecraft instance. */
  | { type: 'developer.minecraft'; scenario: 'ready' | 'chat' | 'world-change' | 'unsafe' | 'unreachable' }
  /** Native file chooser. Model URLs, names and credentials stay in main. Restart applies the imported configuration. */
  | { type: 'models.configure' }
  /** GUI save. Blank fields keep the saved value; credentials never return to the renderer. */
  | { type: 'models.provider.save'; slot: ModelProviderSlot; baseUrl: string; model: string; apiKey?: string }
  | { type: 'models.provider.remove'; slot: ModelProviderSlot }
  | { type: 'models.routing.set'; slot: 'background' | 'privacy' | 'work'; mode: 'follow-main' | 'independent' }
  /** null returns the role to the provider's default thinking level. */
  | { type: 'models.effort.set'; role: 'chat' | 'work'; effort: ReasoningEffort | null }
  /** User-requested fixed-prompt probe of the saved slot; no URL/key/response text returns. */
  | { type: 'models.probe'; slot: ModelProviderSlot }
  /** TTS / Rodin service connections; blank fields keep saved values. */
  | { type: 'models.service.save'; service: 'tts' | 'rodin'; baseUrl: string; model: string; apiKey?: string; voice?: string }
  /** Mail connection fields; auth code never returns to the renderer. */
  | { type: 'mail.configure'; host: string; port?: number; user: string; authCode?: string }
  | { type: 'window.mini' }
  /** Expand the book and destroy its companion window; no timer or session change. */
  | { type: 'window.expand' }
  /** Compatibility alias for window.expand. */
  | { type: 'window.book' }
  /** Mini renderer only; main clamps motion to the connected work areas. */
  | { type: 'window.mini.hover'; over: boolean }
  /** Integer physical-screen pixel displacement, sent at most once per renderer frame. */
  | { type: 'window.mini.moveBy'; dx: number; dy: number }
  /** Compatibility: legacy logical-pixel movement; new renderers use moveBy. */
  | { type: 'window.mini.move'; dx: number; dy: number }
  /** Developer-only, read-only diagnostics BrowserWindow; refused in normal/booth mode. */
  | { type: 'window.diagnostics.open' }
  | { type: 'privacy.set'; enabled: boolean }
  | { type: 'document.attachment'; attachmentId: string }
  | { type: 'document.retry'; documentId: string }
  | { type: 'document.cancel'; documentId: string }
  | { type: 'developer.documents'; scenarioId: DocumentScenarioId }
  | { type: 'developer.document.import'; fixtureId: 'assignment-pdf' | 'notes-text' | 'malformed-pdf' | 'scanned-pdf' }
  | { type: 'memory.extract' }
  /** Book only. Capture the current rendered scene, never an arbitrary rectangle or renderer-supplied image. */
  | { type: 'history.photo.capture' }
  /** Book only, idle normal conversation. No mail/evidence/document reference or raw excerpt is accepted. */
  | { type: 'history.recall'; anchor: RecallAnchor; question: string }
  /** Native configuration chooser, main-only endpoint/credential; absent service stays unconfigured. */
  | { type: 'optical.configure' }
  /** Optional experiment. Disabling never removes canonical text memory or source records. */
  | { type: 'optical.enable'; enabled: boolean }
  /** Encode only witnessed ordinary conversation of a closed session, never arbitrary files/tool results. */
  | { type: 'optical.encode'; sessionId: string }
  /** Tier is an experimental decoder setting, never an automatic age/quality guarantee. */
  | { type: 'optical.decode'; frameId: string; tier: OpticalTier }
  | { type: 'life.schedule'; schedule: 'auto' | 'work' | 'rest' }
  | { type: 'life.propose'; place?: 'coast' | 'swing' }
  | { type: 'life.depart'; outingId: string }
  | { type: 'life.return' }
  /** One work of each kind per calendar day; only registered desk materials, online execution only. */
  | { type: 'life.work.start'; kind: 'read' | 'write' }
  | { type: 'life.work.pause'; workId: string }
  /** Continues from the last verified checkpoint; never resets completed steps or backfills offline work. */
  | { type: 'life.work.resume'; workId: string }
  /** Book-only, user-only native preview of the latest verified product. No text in snapshots/contexts. */
  | { type: 'life.work.open'; workId: string }
  /** Developer profile only: registers and writes fixed synthetic desk materials, without overwriting user files. */
  | { type: 'developer.life.seed' }
  | { type: 'diary.write' }
  | { type: 'room.open' }
  | { type: 'room.rebuild' }
  | { type: 'character.import' }
  | { type: 'character.export' }
  /** Persists selection; explicit app.restart opens its separate relationship scope. */
  | { type: 'character.select'; characterId: string }
  | { type: 'notification.rule.add'; sourceRole: 'any' | 'teaching-assistant' | 'student-club' | 'library' | 'other'; keyword: string }
  | { type: 'notification.rule.remove'; ruleId: string }
  | { type: 'notification.rule.confirm'; ruleId: string }
  | { type: 'notification.rule.discard'; ruleId: string }
  /** D2: user asks for one original in the next turn. One-shot; never a standing grant. */
  | { type: 'context.reveal'; source: 'mail'; ref: string }
  /** Consolidate closed calendar periods from grounded day summaries; repeated identical inputs are no-ops. */
  | { type: 'memory.consolidate' }
  | { type: 'context.compact' }
  | { type: 'session.rollover' }
  | { type: 'developer.memory'; scenarioId: 'ready' | 'failure' | 'invalid' }
  /** Main validates and copies a local plugin folder; no renderer file access or execution. */
  | { type: 'plugin.install'; path: string }
  | { type: 'plugin.enable'; pluginId: string; fingerprint: string }
  | { type: 'plugin.disable'; pluginId: string }
  | { type: 'plugin.privacy.set'; pluginId: string; privacy: 'none' | 'optional' | 'always' }
  | { type: 'developer.set'; enabled: boolean }
  | { type: 'developer.clock'; nowMs?: number; rate?: number; frozen?: boolean }
  | { type: 'developer.scenario'; scenarioId: 'empty' | 'clock-tool' | 'pomodoro-demo' }
  | { type: 'developer.mailbox'; scenarioId: MailScenarioId }
  | { type: 'app.restart' }
)

export type CommandAck = {
  protocolVersion: 1
  requestId: string
  epoch: string
} & ({ status: 'accepted' } | { status: 'rejected'; error: PublicError })

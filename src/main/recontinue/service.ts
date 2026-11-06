import { createHash, randomUUID } from 'node:crypto'
import type { AppCommand, PublicErrorCode, RecontinueCandidateView, RecontinueFork, RecontinueView } from '../../shared'
import type { Clock } from '../clock'
import { sessionDayKey } from '../journal/file'
import type { SessionStore } from '../store/session'
import { continuationPolicy } from './policy'

const words: Record<string, string> = {
  RECONTINUE_DAY: '只能从今天这页重新继续。凌晨四点换日后，旧页保留为历史。',
  RECONTINUE_STALE: '对话或相关工作已有变化，请重新预览。',
  RECONTINUE_TARGET: '这条消息不是当前版本中可重新继续的用户消息。',
  RECONTINUE_OTHER_PROJECT: '这个切点不属于当前项目会话，暂时不能从这里重新继续。',
  RECONTINUE_BUSY: '其他维护操作正在进行，请稍后再试。',
}
export function createRecontinue(options: {
  store: SessionStore; clock: Clock
  execution(): { inspectRecontinue(target: RecontinueFork['target']): Promise<RecontinueFork & { cwd: string }>; recontinue(fork: RecontinueFork, id: string, commit: () => void): Promise<void>
    undoRecontinue(commit: Extract<ReturnType<SessionStore['records']>[number], { type: 'conversation/recontinued' }>, commitUndo: () => void): Promise<void>
    send(text: string, requestId: string, commandHash: string): void
    recontinueKey?(): string; recontinueCandidates?(ids: readonly string[]): Record<string, RecontinueCandidateView>
    recontinueTargets?(assistantIds: readonly string[]): Record<string, string> } | undefined
  unavailable(): boolean
  impact(ids: ReadonlySet<string>): { memories: number; works: number; effects: number; version: string }
  quiesce(ids: ReadonlySet<string>): Promise<void>
  changed(): void
}) {
  const { store, clock } = options
  const empty = () => ({ candidates: {}, retryTargets: {}, versions: [] })
  let state: RecontinueView = { revision: 'initial', phase: 'idle', ...empty() }
  let preview: { id: string; sessionId: string; messageId: string; revision: string; digest: string; fork: RecontinueFork & { cwd: string } } | undefined
  const revision = () => createHash('sha256').update(options.execution()?.recontinueKey?.() ?? `${continuationPolicy(store.records()).revision}:${store.records().at(-1)?.seq ?? 0}`).digest('hex')
  const candidates = () => {
    const rows = store.projection().messages, userIds = rows.filter(message => message.role === 'user').map(message => message.id)
    const assistantIds = rows.filter(message => message.role === 'assistant' && !message.kind).map(message => message.id)
    const execution = options.execution()
    const values = execution?.recontinueCandidates?.(userIds) ?? {}
    return {
      candidates: Object.fromEntries(userIds.map(id => [id, values[id] ?? { available: false, reason: 'no-session' as const }])),
      retryTargets: execution?.recontinueTargets?.(assistantIds) ?? {},
    }
  }
  const recoveredDraft = () => {
    const rows = store.records(), last = continuationPolicy(rows).commits.at(-1)
    if (!last || last.mode === 'retry' || rows.some(row => row.type === 'user/message' && row.seq > last.seq)) return undefined
    const target = rows.find(row => row.type === 'user/message' && row.id === last.targetMessageId)
    return target?.type === 'user/message' ? { operationId: last.operationId, draft: target.text } : undefined
  }
  const versions = () => {
    const rows = store.records(), policy = continuationPolicy(rows), latest = policy.commits.at(-1)?.operationId
    return policy.allCommits.map(commit => {
      const target = rows.find(row => row.type === 'user/message' && row.id === commit.targetMessageId)
      const messages = rows.filter(row => row.seq >= commit.fromSeq && row.seq <= commit.throughSeq && (row.type === 'user/message' || row.type === 'assistant/message')).length
      const active = policy.commits.some(row => row.operationId === commit.operationId)
      const newSpeech = rows.some(row => row.seq > commit.seq && (row.type === 'user/message' || row.type === 'assistant/message'))
      return { operationId: commit.operationId, atMs: commit.atMs, targetMessageId: commit.targetMessageId,
        targetText: target?.type === 'user/message' ? target.text.slice(0, 200) : '', messages, mode: commit.mode ?? 'manual' as const, undone: policy.undone.has(commit.operationId),
        undoable: active && latest === commit.operationId && (commit.mode ?? 'manual') === 'manual' && !newSpeech }
    })
  }
  const check = (sessionId: string, messageId: string, expectedRevision: string, strict = true) => {
    if (sessionId !== store.scope.sessionId || store.dayKey?.() !== sessionDayKey(clock)) throw new Error('RECONTINUE_DAY')
    const rows = store.records(), policy = continuationPolicy(rows)
    // Preview freshness is the full projection revision. Once quiesce starts,
    // non-speech rows (work/cancel receipts) are allowed; the callback below
    // still rejects any new user/assistant message or changed target.
    if (strict && revision() !== expectedRevision) throw new Error('RECONTINUE_STALE')
    const target = rows.find(row => row.type === 'user/message' && row.id === messageId)
    if (target?.type !== 'user/message' || policy.ids.has(messageId) || rows.some(row => row.type === 'question/answered' && row.answerMessageId === messageId)) throw new Error('RECONTINUE_TARGET')
    const messages = rows.filter(row => row.seq >= target.seq && !policy.withdrawn(sessionId, row.seq) && (row.type === 'user/message' || row.type === 'assistant/message'))
    const ids = new Set(messages.flatMap(row => 'id' in row ? [row.id] : []))
    const impact = options.impact(ids)
    const digest = createHash('sha256').update(JSON.stringify([messages, impact])).digest('hex')
    return { target, ids, impact, digest, messages: messages.length }
  }
  const fail = (error: unknown) => {
    if (preview && continuationPolicy(store.records()).commits.some(row => row.operationId === preview!.id)) {
      state = { ...state, revision: revision(), phase: 'complete', completed: recoveredDraft(), preview: undefined, error: undefined }; preview = undefined; options.changed(); return
    }
    const code = error instanceof Error ? error.message : ''
    state = { ...state, revision: revision(), phase: 'failed', preview: undefined, completed: undefined,
      error: words[code] ?? (/^RECONTINUE_(TARGET_AMBIGUOUS|TARGET_MISMATCH|NOT_TURN_START|PENDING_PREFIX)$/.test(code)
        ? '这条消息没有独立、可验证的回合切点，暂时不能从这里重新继续。' : '未能完成重新继续。原始记录已保留，请重新预览核对。') }
    options.changed()
  }
  const busy = () => state.phase === 'previewing' || state.phase === 'committing'
  return {
    busy,
    retry(messageId: string): PublicErrorCode | undefined {
      if (busy()) return 'unavailable'
      if (options.unavailable() || !options.execution()) return 'unavailable'
      if (store.dayKey?.() !== sessionDayKey(clock)) return 'unavailable'
      const rows = store.records(), source = rows.find(row => row.type === 'user/message' && row.id === messageId)
      const failure = rows.findLast(row => row.type === 'narrator/failure')
      if (source?.type !== 'user/message' || rows.findLast(row => row.type === 'user/message')?.id !== source.id
        || failure?.type !== 'narrator/failure' || failure.failure.sourceMessageId !== messageId
        || rows.at(-1)?.type === 'assistant/message' || rows.slice(source.seq).some(row => row.type === 'assistant/message')) return 'invalid-command'
      const candidate = options.execution()!.recontinueCandidates?.([messageId])?.[messageId]
      if (!candidate?.available) return 'invalid-command'
      state = { ...state, ...empty(), revision: revision(), phase: 'committing', preview: undefined, completed: undefined, error: undefined }
      options.changed()
      void (async () => {
        const fork = await options.execution()!.inspectRecontinue({ messageId, text: source.text })
        const nextRootId = `retry-${randomUUID()}`
        await options.execution()!.recontinue(fork, nextRootId, () => {
          const current = store.records(), target = current.find(row => row.type === 'user/message' && row.id === messageId)
          if (target?.type !== 'user/message' || current.some(row => row.seq > target.seq && row.type === 'assistant/message')) throw new Error('RECONTINUE_STALE')
          store.append({ type: 'conversation/recontinued', operationId: randomUUID(), parentRevision: continuationPolicy(current).revision, targetMessageId: messageId, mode: 'retry',
            fromSeq: target.seq, throughSeq: current.at(-1)!.seq, sourceRootId: fork.sourceId, nextRootId, cwd: fork.cwd })
        })
        const requestId = `retry-${randomUUID()}`
        options.execution()!.send(source.text, requestId, createHash('sha256').update(requestId + source.text).digest('hex'))
        state = { ...state, ...empty(), revision: revision(), phase: 'idle', preview: undefined, completed: undefined, error: undefined }
        options.changed()
      })().catch(fail)
      return
    },
    view: (): RecontinueView => {
      const completed = recoveredDraft(), current = candidates()
      return { ...structuredClone(state), ...(state.phase === 'idle' && completed ? { phase: 'complete' as const } : {}), completed, revision: revision(),
        candidates: current.candidates, retryTargets: current.retryTargets, versions: versions() }
    },
    dispatch(command: AppCommand): PublicErrorCode | undefined {
      if (!command.type.startsWith('recontinue.')) return 'invalid-command'
      if (busy()) return 'unavailable'
      if (command.type === 'recontinue.cancel') { preview = undefined; state = { ...state, ...empty(), revision: revision(), phase: 'idle', preview: undefined, completed: undefined, error: undefined }; options.changed(); return }      if (options.unavailable() || !options.execution()) return 'unavailable'
      if (command.type === 'recontinue.undo') {
        const rows = store.records(), policy = continuationPolicy(rows), commit = policy.allCommits.find(row => row.operationId === command.operationId)
        if (!commit || policy.undone.has(commit.operationId) || policy.commits.at(-1)?.operationId !== commit.operationId || (commit.mode ?? 'manual') !== 'manual'
          || rows.some(row => row.seq > commit.seq && (row.type === 'user/message' || row.type === 'assistant/message'))) {
          state = { ...state, revision: revision(), phase: 'failed', error: '这次重新继续已经不能撤销了。' }; options.changed(); return
        }
        state = { ...state, revision: revision(), phase: 'committing', error: undefined, preview: undefined }; options.changed()
        void (async () => {
          await options.execution()!.undoRecontinue(commit, () => store.append({ type: 'conversation/recontinue-undone', operationId: commit.operationId }))
          preview = undefined
          state = { ...state, ...empty(), revision: revision(), phase: 'idle', completed: undefined, preview: undefined, error: undefined }
          options.changed()
        })().catch(fail)
        return
      }
      if (command.type === 'recontinue.preview') {
        preview = undefined; state = { ...state, ...empty(), revision: revision(), phase: 'previewing', preview: undefined, completed: undefined, error: undefined }; options.changed()
        void (async () => {
          const before = check(command.sessionId, command.messageId, command.revision)
          const fork = await options.execution()!.inspectRecontinue({ messageId: command.messageId, text: before.target.text })
          const after = check(command.sessionId, command.messageId, command.revision)
          if (before.digest !== after.digest) throw new Error('RECONTINUE_STALE')
          const id = randomUUID()
          preview = { id, sessionId: command.sessionId, messageId: command.messageId, revision: command.revision, digest: after.digest, fork }
          state = { ...state, ...empty(), revision: revision(), phase: 'ready', preview: { id, messageId: command.messageId, text: before.target.text, messages: after.messages,
            memories: after.impact.memories, works: after.impact.works, effects: after.impact.effects } }
          options.changed()
        })().catch(fail)
        return
      }
      if (command.type === 'recontinue.commit') {
        if (store.records().some(row => row.type === 'conversation/recontinued' && row.operationId === command.previewId)) return
        const chosen = preview
        if (!chosen || chosen.id !== command.previewId) return 'invalid-command'
        state = { ...state, phase: 'committing' }; options.changed()
        void (async () => {
          const before = check(chosen.sessionId, chosen.messageId, chosen.revision)
          if (before.digest !== chosen.digest) throw new Error('RECONTINUE_STALE')
          await options.quiesce(before.ids)
          await options.execution()!.recontinue(chosen.fork, `recontinue-${chosen.id}`, () => {
            const current = check(chosen.sessionId, chosen.messageId, chosen.revision, false)
            // Cancellation changes work status, but cannot introduce new speech.
            if (current.messages !== before.messages || current.target.text !== before.target.text) throw new Error('RECONTINUE_STALE')
            store.append({ type: 'conversation/recontinued', operationId: chosen.id, parentRevision: continuationPolicy(store.records()).revision, targetMessageId: chosen.messageId, mode: 'manual',
              fromSeq: current.target.seq, throughSeq: store.records().at(-1)!.seq, sourceRootId: chosen.fork.sourceId,
              nextRootId: `recontinue-${chosen.id}`, cwd: chosen.fork.cwd })
          })
          state = { ...state, ...empty(), revision: revision(), phase: 'complete', completed: { operationId: chosen.id, draft: before.target.text } }; preview = undefined
          options.changed()
        })().catch(fail)
        return
      }
      return 'invalid-command'
    },
  }
}
export type RecontinueService = ReturnType<typeof createRecontinue>

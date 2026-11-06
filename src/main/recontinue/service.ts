import { createHash, randomUUID } from 'node:crypto'
import type { AppCommand, PublicErrorCode, RecontinueFork, RecontinueView } from '../../shared'
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
  execution(): { inspectRecontinue(target: RecontinueFork['target']): Promise<RecontinueFork & { cwd: string }>; recontinue(fork: RecontinueFork, id: string, commit: () => void): Promise<void> } | undefined
  unavailable(): boolean
  impact(ids: ReadonlySet<string>): { memories: number; works: number; effects: number; version: string }
  quiesce(ids: ReadonlySet<string>): Promise<void>
  changed(): void
}) {
  const { store, clock } = options
  let state: RecontinueView = { revision: 'initial', phase: 'idle' }
  let preview: { id: string; sessionId: string; messageId: string; revision: string; digest: string; fork: RecontinueFork & { cwd: string } } | undefined
  const revision = () => continuationPolicy(store.records()).revision
  const recoveredDraft = () => {
    const rows = store.records(), last = continuationPolicy(rows).commits.at(-1)
    if (!last || rows.some(row => row.type === 'user/message' && row.seq > last.seq)) return undefined
    const target = rows.find(row => row.type === 'user/message' && row.id === last.targetMessageId)
    return target?.type === 'user/message' ? { operationId: last.operationId, draft: target.text } : undefined
  }
  const check = (sessionId: string, messageId: string, expectedRevision: string) => {
    if (sessionId !== store.scope.sessionId || store.dayKey?.() !== sessionDayKey(clock)) throw new Error('RECONTINUE_DAY')
    const rows = store.records(), policy = continuationPolicy(rows)
    if (policy.revision !== expectedRevision) throw new Error('RECONTINUE_STALE')
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
      state = { revision: revision(), phase: 'complete', completed: recoveredDraft() }; preview = undefined; options.changed(); return
    }
    const code = error instanceof Error ? error.message : ''
    state = { revision: revision(), phase: 'failed', error: words[code] ?? (/^RECONTINUE_(TARGET_AMBIGUOUS|TARGET_MISMATCH|NOT_TURN_START|PENDING_PREFIX)$/.test(code)
      ? '这条消息没有独立、可验证的回合切点，暂时不能从这里重新继续。' : '未能完成重新继续。原始记录已保留，请重新预览核对。') }
    options.changed()
  }
  const busy = () => state.phase === 'previewing' || state.phase === 'committing'
  return {
    busy,
    view: (): RecontinueView => {
      const completed = recoveredDraft()
      return { ...structuredClone(state), ...(state.phase === 'idle' && completed ? { phase: 'complete' as const } : {}), completed, revision: revision() }
    },
    dispatch(command: AppCommand): PublicErrorCode | undefined {
      if (!command.type.startsWith('recontinue.')) return 'invalid-command'
      if (busy()) return 'unavailable'
      if (command.type === 'recontinue.cancel') { preview = undefined; state = { revision: revision(), phase: 'idle' }; options.changed(); return }
      if (options.unavailable() || !options.execution()) return 'unavailable'
      if (command.type === 'recontinue.preview') {
        preview = undefined; state = { revision: revision(), phase: 'previewing' }; options.changed()
        void (async () => {
          const before = check(command.sessionId, command.messageId, command.revision)
          const fork = await options.execution()!.inspectRecontinue({ messageId: command.messageId, text: before.target.text })
          const after = check(command.sessionId, command.messageId, command.revision)
          if (before.digest !== after.digest) throw new Error('RECONTINUE_STALE')
          const id = randomUUID()
          preview = { id, sessionId: command.sessionId, messageId: command.messageId, revision: command.revision, digest: after.digest, fork }
          state = { revision: revision(), phase: 'ready', preview: { id, messageId: command.messageId, text: before.target.text, messages: after.messages,
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
            const current = check(chosen.sessionId, chosen.messageId, chosen.revision)
            // Cancellation changes work status, but cannot introduce new speech.
            if (current.messages !== before.messages || current.target.text !== before.target.text) throw new Error('RECONTINUE_STALE')
            store.append({ type: 'conversation/recontinued', operationId: chosen.id, parentRevision: chosen.revision, targetMessageId: chosen.messageId,
              fromSeq: current.target.seq, throughSeq: store.records().at(-1)!.seq, sourceRootId: chosen.fork.sourceId,
              nextRootId: `recontinue-${chosen.id}`, cwd: chosen.fork.cwd })
          })
          state = { revision: revision(), phase: 'complete', completed: { operationId: chosen.id, draft: before.target.text } }; preview = undefined
          options.changed()
        })().catch(fail)
        return
      }
      return 'invalid-command'
    },
  }
}
export type RecontinueService = ReturnType<typeof createRecontinue>

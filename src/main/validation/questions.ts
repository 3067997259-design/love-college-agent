import { randomUUID } from 'node:crypto'
import { createManualClock } from '../clock'
import { openSessionStore } from '../store/session'
import { createQuestions } from '../questions/service'
import type { AppCommand } from '../../shared'

/** Real SQLite plus delayed page rotation; no model/network or imported runtime data. */
export async function probeQuestions(root: string) {
  const clock = createManualClock(0); clock.advanceBy(clock.parse('2026-10-17T03:59:00+08:00'))
  const owner = { userId: 'quota-user', characterId: 'quota-character' }
  let store = openSessionStore(root, owner, clock)
  const open = () => createQuestions({ store, clock, changed: () => {}, safeText: (text) => text })
  const ask = (question: string) => [{ id: 'q', question, options: [], multiSelect: false }]
  let questions = open()
  const batch = async () => {
    for (let turn = 0; turn < 4; turn++) {
      const turnId = randomUUID(); store.append({ type: 'turn/start', turnId, trigger: 'user' })
      for (let i = 0; i < 3; i++) {
        const waiting = questions.ask(ask('Synthetic quota check'), { store, clock, signal: new AbortController().signal, turnId, callId: randomUUID() })
        const view = questions.view(); if (view?.status !== 'waiting') throw new Error('QUESTION_QUOTA_EARLY_REFUSAL')
        const error = questions.dispatch({ protocolVersion: 1, epoch: 'probe', requestId: randomUUID(), type: 'question.dismiss', questionId: view.id } as AppCommand, 'probe')
        if (error || (await waiting).ok) throw new Error('QUESTION_QUOTA_DISMISS_FAILED')
      }
      store.append({ type: 'turn/end', turnId, reason: 'completed' })
    }
  }
  const limited = async () => {
    const turnId = randomUUID(); store.append({ type: 'turn/start', turnId, trigger: 'user' })
    const result = await questions.ask(ask('Thirteenth request'), { store, clock, signal: new AbortController().signal, turnId, callId: randomUUID() })
    if (questions.view() || (result.visible as { status?: string }).status !== 'question-limit') throw new Error('QUESTION_QUOTA_RESET')
    store.append({ type: 'turn/end', turnId, reason: 'completed' })
  }
  try {
    await batch(); await limited()
    clock.advanceBy(120_000); await batch(); await limited()
    if (store.dayKey?.() !== '2026-10-16' || !store.rotate?.() || store.records().some((row) => row.type === 'question/requested')) throw new Error('QUESTION_DELAYED_ROTATION_MISSING')
    await limited(); questions.close(); store.close()
    store = openSessionStore(root, owner, clock); questions = open(); await limited()
    // Both owner axes are independent, even at the identical wall clock time.
    for (const other of [{ ...owner, characterId: 'other-character' }, { ...owner, userId: 'other-user' }]) {
      questions.close(); store.close(); store = openSessionStore(root, other, clock); questions = open(); await batch()
    }
    questions.close(); store.close(); store = openSessionStore(root, owner, clock); questions = open()
    clock.advanceBy(86400_000); await batch(); await limited()
    return { ok: true, probe: 'questions', actualSQLite: true, delayedRotationQuotaRetained: true, restartQuotaRetained: true, nextDayReset: true, userAndCharacterIsolated: true }
  } finally { questions.close(); store.close() }
}

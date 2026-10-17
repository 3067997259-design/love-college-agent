import { useState } from 'react'
import type { AppBridge, AppSnapshot, UserQuestionView } from '../../../shared'
import { sendCommand } from './command'
import words from '../voice/questions.zh.json'

export function QuestionControls({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const question = snapshot.question
  if (!question) return null
  if (question.status === 'queued') return <p role="status" data-question="queued">{words.queued}</p>
  return <Answer key={question.id} question={question} epoch={snapshot.epoch} bridge={bridge} />
}
function Answer({ question, epoch, bridge }: { question: Extract<UserQuestionView, { status: 'waiting' }>; epoch: string; bridge: AppBridge }) {
  const [answer, setAnswer] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(false)
  async function submit(dismiss = false) {
    if (busy) return
    setBusy(true)
    try {
      const result = await sendCommand(bridge, epoch, dismiss ? { type: 'question.dismiss', questionId: question.id } : { type: 'question.answer', questionId: question.id, answer })
      setError(!result.ok)
    } finally { setBusy(false) }
  }
  return <section className="card" aria-label={words.title} data-question="waiting">
    <strong>{question.question}</strong>
    <div>{question.choices.map((choice) => <button type="button" className="btn btn-ghost" key={choice} disabled={busy} onClick={() => setAnswer(choice)}>{choice}</button>)}</div>
    <label>{words.answer}<textarea aria-label={words.answer} rows={2} value={answer} maxLength={2000} onChange={(event) => setAnswer(event.target.value)} /></label>
    <p>{words.hint}</p>
    <button type="button" className="btn btn-primary" disabled={busy || !answer.trim()} onClick={() => void submit()}>{words.send}</button>
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void submit(true)}>{words.dismiss}</button>
    {error && <p role="alert">{words.error}</p>}
  </section>
}

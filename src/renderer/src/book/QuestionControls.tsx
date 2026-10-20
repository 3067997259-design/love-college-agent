import { useState } from 'react'
import type { AppBridge, AppSnapshot, UserQuestionView } from '../../../shared'
import words from '../voice/questions.zh.json'
import { Notice } from './CommandControls'
import { useAct } from './useAct'

/**
 * 她向你提问（主进程的 ask_user）：停在输入框上面，问题用她的墨色，像她在问你。
 * 专注和安静时只排队，留一行小字；休息时才展开。回答只是补充信息，不等于批准运行或确认事项。
 * 点选项就直接回答；想说别的再写在下面。审批（她要运行命令、要你信任项目）只有选项，点一下就定。
 */
export function QuestionControls({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const question = snapshot.question
  if (!question) return null
  if (question.status === 'queued') return <p className="dock-line" role="status" data-question="queued">{words.queued}</p>
  return <Answer key={question.id} question={question} snapshot={snapshot} bridge={bridge} />
}

function Answer({ question, snapshot, bridge }: { question: Extract<UserQuestionView, { status: 'waiting' }>; snapshot: AppSnapshot; bridge: AppBridge }) {
  const [answer, setAnswer] = useState('')
  const act = useAct(bridge, snapshot, question.id)
  const approval = question.kind === 'approval'
  const length = [...answer.trim()].length
  const valid = length > 0 && length <= 1000
  const reply = (text: string) => { if (!act.busy) void act.send({ type: 'question.answer', questionId: question.id, answer: text }) }
  const submit = (dismiss = false) => {
    if (act.busy || (!dismiss && !valid)) return
    void act.send(dismiss ? { type: 'question.dismiss', questionId: question.id } : { type: 'question.answer', questionId: question.id, answer })
  }
  return (
    <section className="dock-card dock-question" aria-label={approval ? words.approvalTitle : words.title} data-question="waiting" data-kind={approval ? 'approval' : undefined}>
      <p className="question-text"><span className="msg-who" aria-hidden />{question.question}</p>
      {approval
        ? (
          <div className="card-actions dock-actions" role="group" aria-label={words.choices}>
            {question.choices.map((choice, index) => (
              <button type="button" key={choice} className={`btn btn-small ${index === 0 ? 'btn-primary' : 'btn-ghost'}`} disabled={act.busy} onClick={() => reply(choice)}>{choice}</button>
            ))}
            {act.busy && <span className="work-sending" role="status">{words.sending}</span>}
          </div>
        )
        : <>
          {question.choices.length > 0 && (
            <div className="question-choices" role="group" aria-label={words.choices}>
              {question.choices.map((choice) => (
                <button type="button" key={choice} className="choice-chip" disabled={act.busy} onClick={() => reply(choice)}>{choice}</button>
              ))}
            </div>
          )}
          <textarea className="question-input" aria-label={words.answer} placeholder={question.choices.length ? words.placeholderOther : words.placeholder} rows={2} value={answer} disabled={act.busy}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} />
          <div className="question-foot">
            <span className="flow-note">{words.hint}</span>
            {length > 0 && (
              <span className="question-length" data-answer-length="true" data-over={length > 1000} role={length > 1000 ? 'alert' : 'status'}>
                {words.length.replace('{count}', String(length))}{length > 1000 && ` ${words.tooLong}`}
              </span>
            )}
          </div>
          <div className="card-actions dock-actions">
            <button type="button" className="btn btn-primary btn-small" disabled={act.busy || !valid} onClick={() => submit()}>{words.send}</button>
            <button type="button" className="btn btn-ghost btn-small" disabled={act.busy} onClick={() => submit(true)}>{words.dismiss}</button>
            {act.busy && <span className="work-sending" role="status">{words.sending}</span>}
          </div>
        </>}
      {act.failed && <Notice>{words.error}</Notice>}
    </section>
  )
}

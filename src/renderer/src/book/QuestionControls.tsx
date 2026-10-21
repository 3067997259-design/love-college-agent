import { useState } from 'react'
import type { AppBridge, AppSnapshot, QuestionAnswer, QuestionItemView, UserQuestionView } from '../../../shared'
import words from '../voice/questions.zh.json'
import { Notice } from './Notice'
import { useAct } from './useAct'

type Waiting = Extract<UserQuestionView, { status: 'waiting' }>

/**
 * 她向你提问（DSH 的 ask_user_question）：停在输入框上面，问题用她的墨色，像她在问你。
 * 专注和安静时只排队，留一行小字；休息时才展开。回答只是补充信息，不等于批准运行或确认事项。
 * 她一次可以问一到四件事：一件事、点一个选项就直接回答；几件事就一件一件往下点，最后一起交给她。
 * 审批（她要运行命令、要你信任项目）只有选项，点一下就定。
 */
export function QuestionControls({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const question = snapshot.question
  if (!question) return null
  if (question.status === 'queued') return <p className="dock-line" role="status" data-question="queued">{words.queued}</p>
  if (question.kind === 'approval') return <Approval key={question.id} question={question} snapshot={snapshot} bridge={bridge} />
  return question.items?.length ? <Questions key={question.id} question={question} items={question.items} snapshot={snapshot} bridge={bridge} /> : null
}

function Approval({ question, snapshot, bridge }: { question: Waiting; snapshot: AppSnapshot; bridge: AppBridge }) {
  const act = useAct(bridge, snapshot, question.id)
  return (
    <section className="dock-card dock-question" aria-label={words.approvalTitle} data-question="waiting" data-kind="approval">
      <p className="question-text"><span className="msg-who" aria-hidden />{question.question}</p>
      <div className="card-actions dock-actions" role="group" aria-label={words.choices}>
        {question.choices.map((choice, index) => (
          <button type="button" key={choice} className={`btn btn-small ${index === 0 ? 'btn-primary' : 'btn-ghost'}`} disabled={act.busy}
            onClick={() => { if (!act.busy) void act.send({ type: 'question.answer', questionId: question.id, answer: choice }) }}>{choice}</button>
        ))}
        {act.busy && <span className="work-sending" role="status">{words.sending}</span>}
      </div>
      {act.failed && <Notice>{words.error}</Notice>}
    </section>
  )
}

const length = (text: string | undefined) => [...(text ?? '').trim()].length

function Questions({ question, items, snapshot, bridge }: { question: Waiting; items: readonly QuestionItemView[]; snapshot: AppSnapshot; bridge: AppBridge }) {
  const [index, setIndex] = useState(0)
  const [picks, setPicks] = useState<Record<string, readonly string[]>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const act = useAct(bridge, snapshot, question.id)
  const item = items[Math.min(index, items.length - 1)]
  const several = items.length > 1
  const last = index >= items.length - 1
  const picked = picks[item.id] ?? []
  const note = notes[item.id] ?? ''
  const answeredOne = (entry: QuestionItemView, from = picks) => (from[entry.id]?.length ?? 0) > 0 || length(notes[entry.id]) > 0
  const answers = (from = picks): QuestionAnswer[] => items.map((entry) => ({ id: entry.id, selected: [...(from[entry.id] ?? [])],
    ...(length(notes[entry.id]) ? { custom: notes[entry.id].trim() } : {}) }))
  const tooLong = items.some((entry) => length(notes[entry.id]) > 1000)
  const ready = items.some((entry) => answeredOne(entry)) && !tooLong
  const send = (from = picks) => { if (!act.busy && !tooLong) void act.send({ type: 'question.answer', questionId: question.id, answers: answers(from) }) }
  const choose = (label: string) => {
    if (act.busy) return
    if (item.multiSelect) { setPicks({ ...picks, [item.id]: picked.includes(label) ? picked.filter((entry) => entry !== label) : [...picked, label] }); return }
    const next = { ...picks, [item.id]: picked[0] === label ? [] : [label] }
    setPicks(next)
    if (!next[item.id].length) return
    // 只问一件事：点选项就是回答。问了几件：点完这一件，翻到下一件。
    if (!several) send(next)
    else if (!last) setIndex(index + 1)
  }
  const described = item.options.some((option) => option.description)
  const noteLength = length(note)
  return (
    <section className="dock-card dock-question" aria-label={words.title} data-question="waiting" data-count={items.length}>
      {several && (
        <div className="question-steps" role="group" aria-label={words.steps.replace('{count}', String(items.length))}>
          {items.map((entry, position) => (
            <button type="button" key={entry.id} className="question-step" aria-current={position === index ? 'step' : undefined} data-answered={answeredOne(entry)}
              aria-label={words.step.replace('{index}', String(position + 1)) + (entry.header ? `：${entry.header}` : '')} onClick={() => setIndex(position)} />
          ))}
          <span className="question-count">{words.progress.replace('{index}', String(index + 1)).replace('{count}', String(items.length))}</span>
        </div>
      )}
      <p className="question-text"><span className="msg-who" aria-hidden />{item.header && <span className="question-header">{item.header}</span>}{item.question}</p>
      {item.options.length > 0 && (described
        ? (
          <div className="question-options" role="group" aria-label={item.multiSelect ? words.choicesMany : words.choices}>
            {item.options.map((option) => (
              <button type="button" key={option.label} className="choice-row" aria-pressed={picked.includes(option.label)} data-many={item.multiSelect} disabled={act.busy} onClick={() => choose(option.label)}>
                <span className="choice-mark" aria-hidden />
                <span className="choice-label">{option.label}</span>
                {option.description && <span className="choice-note">{option.description}</span>}
              </button>
            ))}
          </div>
        )
        : (
          <div className="question-choices" role="group" aria-label={item.multiSelect ? words.choicesMany : words.choices}>
            {item.options.map((option) => (
              <button type="button" key={option.label} className="choice-chip" aria-pressed={picked.includes(option.label)} data-many={item.multiSelect} disabled={act.busy} onClick={() => choose(option.label)}>{option.label}</button>
            ))}
          </div>
        ))}
      {item.multiSelect && <p className="flow-note question-many">{words.many}</p>}
      <textarea className="question-input" aria-label={words.answer} placeholder={item.options.length ? words.placeholderOther : words.placeholder} rows={item.options.length ? 1 : 2} value={note} disabled={act.busy}
        onChange={(event) => setNotes({ ...notes, [item.id]: event.target.value })}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          if (several && !last) setIndex(index + 1)
          else if (ready) send()
        }} />
      <div className="question-foot">
        <span className="flow-note">{words.hint}</span>
        {noteLength > 0 && (
          <span className="question-length" data-answer-length="true" data-over={noteLength > 1000} role={noteLength > 1000 ? 'alert' : 'status'}>
            {words.length.replace('{count}', String(noteLength))}{noteLength > 1000 && ` ${words.tooLong}`}
          </span>
        )}
      </div>
      <div className="card-actions dock-actions">
        {several && index > 0 && <button type="button" className="btn btn-ghost btn-small" disabled={act.busy} onClick={() => setIndex(index - 1)}>{words.previous}</button>}
        {several && !last
          ? <button type="button" className={`btn btn-small ${answeredOne(item) ? 'btn-primary' : 'btn-ghost'}`} disabled={act.busy} onClick={() => setIndex(index + 1)}>{answeredOne(item) ? words.next : words.skipOne}</button>
          : <button type="button" className="btn btn-primary btn-small" disabled={act.busy || !ready} onClick={() => send()}>{words.send}</button>}
        <button type="button" className="btn btn-ghost btn-small" disabled={act.busy} onClick={() => { if (!act.busy) void act.send({ type: 'question.dismiss', questionId: question.id }) }}>{words.dismiss}</button>
        {act.busy && <span className="work-sending" role="status">{words.sending}</span>}
      </div>
      {act.failed && <Notice>{words.error}</Notice>}
    </section>
  )
}

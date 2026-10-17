import type { ModelFailureView } from '../../../shared'
import words from '../voice/failure.zh.json'
import './failure.css'

export function FailureDetails({ failure, onDraft }: { failure: ModelFailureView; onDraft?: () => void }) {
  return <div className="failure-details" aria-label={words.title} data-failure-turn={failure.turnId}>
    <details><summary>{words.details}</summary><p>{words.code}：<code>{failure.code}</code></p><p>{words.attempts}：{failure.attemptCount}</p>{failure.httpStatus !== undefined && <p>{words.http}：{failure.httpStatus}</p>}</details>
    {failure.toolsExecuted && <p>{words.tools}</p>}
    {onDraft && <button type="button" className="link-button" onClick={onDraft}>{words.retry}</button>}
  </div>
}

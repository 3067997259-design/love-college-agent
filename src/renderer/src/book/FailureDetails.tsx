import type { ModelFailureView } from '../../../shared'
import words from '../voice/failure.zh.json'
import { Notice } from './CommandControls'
import './work.css'

/**
 * 失败旁白下面的说明（主进程给的闭集原因，不是她说的话）：
 * 调用过工具就先提醒核对已产生的结果；原因可展开（错误代码、服务状态、尝试次数，不含供应商原文或配置）；
 * 原请求只带回输入框，你检查后手动发送。
 */
export function FailureDetails({ failure, onDraft }: { failure: ModelFailureView; onDraft?: () => void }) {
  return (
    <div className="failure-details" aria-label={words.title} data-failure-turn={failure.turnId}>
      {failure.toolsExecuted && <Notice live={false}>{words.tools}</Notice>}
      <div className="failure-row">
        {onDraft && <button type="button" className="link-button" onClick={onDraft}>{words.retry}</button>}
        <details className="failure-why">
          <summary>{words.details}</summary>
          <dl className="failure-facts">
            <dt>{words.code}</dt><dd><code>{failure.code}</code></dd>
            {failure.httpStatus !== undefined && <><dt>{words.http}</dt><dd>{failure.httpStatus}</dd></>}
            <dt>{words.attempts}</dt><dd>{failure.attemptCount}</dd>
          </dl>
        </details>
      </div>
    </div>
  )
}

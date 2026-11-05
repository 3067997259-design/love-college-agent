import { useState } from 'react'
import type { AppBridge, AppSnapshot, ResourcePurpose } from '../../../shared'
import { dayKeyLabel } from '../book/life/text'
import { SettingsIssue } from './SettingsIssue'

const PURPOSE_LABEL: Record<ResourcePurpose, string> = { memory: '整理记忆', diary: '写日记', mail: '看邮件', desk: '书桌作品', other: '其他' }
const PURPOSES: readonly ResourcePurpose[] = ['memory', 'diary', 'mail', 'desk', 'other']
const number = (value: number | null) => value === null ? '—' : value.toLocaleString('en-US')

/**
 * 运行资源：今天用了多少额度、她自己做事那一份怎么分，以及两个上限。
 * 数字是按请求大小估的预留量（不是实际 token 或费用），模型日从 04:00 算起。
 * 分项上限只约束带用途的新记录；更新前写下的旧记录没有用途，记在“其他”里，
 * 所以那一天的“其他”可能超过它自己的上限，这时下面多一句说明。
 */
export function ResourceControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const view = snapshot.resources; const [total, setTotal] = useState<number | null>(null); const [autonomous, setAutonomous] = useState<number | null>(null); const [error, setError] = useState('')
  if (!view) return null
  const save = async () => {
    try {
      const ack = await bridge.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'resources.configure', dailyTotalUnits: total ?? view.model.totalLimitUnits, dailyAutonomousUnits: autonomous ?? view.model.autonomousLimitUnits })
      setError(ack.status === 'rejected' ? ack.error.code : ''); if (ack.status === 'accepted') { setTotal(null); setAutonomous(null) }
    } catch { setError('unavailable') }
  }
  const { model, speech } = view
  const unlabeled = model.autonomousBreakdown.other > model.autonomousPurposeLimits.other
  return <section aria-label="运行资源">
    <p className="settings-note">{dayKeyLabel(model.dayKey)} · 每天 04:00 换日{model.attemptCount !== null && ` · 今天请求了 ${model.attemptCount} 次`}</p>
    <table className="settings-usage">
      <tbody>
        <tr><th scope="row">全部</th><td>{number(model.totalReservedUnits)} / {number(model.totalLimitUnits)}</td></tr>
        <tr><th scope="row">她自己做的事</th><td>{number(model.autonomousReservedUnits)} / {number(model.autonomousLimitUnits)}</td></tr>
        {PURPOSES.filter((purpose) => model.autonomousPurposeLimits[purpose] > 0 || model.autonomousBreakdown[purpose] > 0).map((purpose) => <tr key={purpose} data-sub><th scope="row">{PURPOSE_LABEL[purpose]}</th><td>{number(model.autonomousBreakdown[purpose])} / {number(model.autonomousPurposeLimits[purpose])}</td></tr>)}
        <tr><th scope="row">语音</th><td>{number(speech.reservedChars)} / {number(speech.charLimit)} 字</td></tr>
        <tr data-sub><th scope="row">次数</th><td>{number(speech.attemptCount)} / {number(speech.attemptLimit)}</td></tr>
      </tbody>
    </table>
    <p className="settings-note">数字是按请求大小估的预留量，不是实际的 token 或费用。{unlabeled && '更新前的用量没有分类，先记在「其他」里，不占它的额度。'}</p>
    {view.configurable && <>
      <label>每天总额度<input aria-label="每天总额度" type="number" min={10000} max={5000000} step={10000} value={total ?? model.totalLimitUnits} onChange={(event) => setTotal(Number(event.target.value))} /></label>
      <label>她自己做事的额度<input aria-label="她自己做事的额度" type="number" min={0} max={total ?? model.totalLimitUnits} step={10000} value={autonomous ?? model.autonomousLimitUnits} onChange={(event) => setAutonomous(Number(event.target.value))} /></label>
      <div className="settings-actions"><button disabled={view.status !== 'ready'} onClick={() => void save()}>保存额度</button></div>
      <p className="settings-note">她自己做的事（整理记忆、写日记、书桌作品）各有一份，互不挤占。你发的消息、你让她做的事和看邮件另算，不受这份额度限制。调低只影响之后的请求。</p>
    </>}
    {view.status !== 'ready' && <p role="alert">用量账本打不开，模型请求先停了。书本里的东西都在。</p>}
    <SettingsIssue code={error} />
  </section>
}

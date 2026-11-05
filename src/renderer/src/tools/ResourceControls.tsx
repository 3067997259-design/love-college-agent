import { useState } from 'react'
import type { AppBridge, AppSnapshot, ResourcePurpose } from '../../../shared'

const PURPOSE_LABEL: Record<ResourcePurpose, string> = { memory: '整理记忆', diary: '日记', mail: '邮件', desk: '书桌', other: '其他' }
const PURPOSES: readonly ResourcePurpose[] = ['memory', 'diary', 'mail', 'desk', 'other']

export function ResourceControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const view = snapshot.resources; const [total, setTotal] = useState<number | null>(null); const [autonomous, setAutonomous] = useState<number | null>(null); const [error, setError] = useState('')
  if (!view) return null
  const save = async () => {
    try {
      const ack = await bridge.dispatch({ protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID(), type: 'resources.configure', dailyTotalUnits: total ?? view.model.totalLimitUnits, dailyAutonomousUnits: autonomous ?? view.model.autonomousLimitUnits })
      setError(ack.status === 'rejected' ? ack.error.code : ''); if (ack.status === 'accepted') { setTotal(null); setAutonomous(null) }
    } catch { setError('unavailable') }
  }
  const count = (value: number | null) => value === null ? '未知' : String(value)
  return <section aria-label="运行资源"><h2>运行资源</h2>
    <p>同一数据根共享；恢复书本不会退还已准入的资源。预留单位是请求体与输出上限的保守估计，实际 token 和费用仍未知。</p>
    <p>模型日 {view.model.dayKey}（04:00 分日）· 总预留 {count(view.model.totalReservedUnits)}/{view.model.totalLimitUnits} · 自主 {count(view.model.autonomousReservedUnits)}/{view.model.autonomousLimitUnits} · 尝试 {count(view.model.attemptCount)} · 迁入旧预留 {count(view.model.legacyReservedUnits)}</p>
    <p>自主分项：{PURPOSES.map((purpose) => `${PURPOSE_LABEL[purpose]} ${count(view.model.autonomousBreakdown[purpose])}/${view.model.autonomousPurposeLimits[purpose]}`).join(' · ')}</p>
    <p>语音日 {view.speech.dayKey} · 字符 {count(view.speech.reservedChars)}/{view.speech.charLimit} · 尝试 {count(view.speech.attemptCount)}/{view.speech.attemptLimit}</p>
    {view.configurable && <><label>总日预留上限<input aria-label="总日预留上限" type="number" min={10000} max={5000000} step={10000} value={total ?? view.model.totalLimitUnits} onChange={(event) => setTotal(Number(event.target.value))} /></label>
      <label>自主日预留上限<input aria-label="自主日预留上限" type="number" min={0} max={total ?? view.model.totalLimitUnits} step={10000} value={autonomous ?? view.model.autonomousLimitUnits} onChange={(event) => setAutonomous(Number(event.target.value))} /></label>
      <button disabled={view.status !== 'ready'} onClick={() => void save()}>保存每日预算</button>
      <p>自主额度只算她自发做的后台事情（整理记忆、写日记、扫邮件、书桌作品），并已按这些类别分开、互不挤占；模型日每天 04:00 重置。你发的消息、点「请她补写」或主动要求整理记忆不占这个桶，也不会被它挡住，只记录用量。调低只影响之后的请求，不退还已经预留的部分。</p></>}
    {(error || view.status !== 'ready') && <p role="alert">{error || '资源账本不可用，请求已关闭；原书本仍保留。'}</p>}
  </section>
}

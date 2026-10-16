import { useEffect, useState } from 'react'
import type { AppBridge, AppSnapshot, DiagnosticsView } from '../../../shared'
import { sendCommand } from '../book/command'

export function DiagnosticsControls({ bridge, snapshot, standalone = false }: { bridge: AppBridge; snapshot: AppSnapshot; standalone?: boolean }) {
  const [data, setData] = useState<DiagnosticsView | null>(null); const [error, setError] = useState('')
  useEffect(() => { setData(null); setError('') }, [snapshot.epoch])
  useEffect(() => {
    if (!standalone || snapshot.runtime?.developer.mode !== 'developer' || !bridge.readDiagnostics) return
    let active = true; let dirty = true; let reading = false; let last = -Infinity; let frame = 0
    const stop = bridge.subscribe(() => { dirty = true })
    // UI-only refresh: at most once per second, no business-clock advancement and no model requests.
    const tick = (at: number) => {
      if (!active) return
      if (dirty && !reading && at - last >= 1000) {
        dirty = false; reading = true; last = at
        void bridge.readDiagnostics!().then((view) => { if (active) { setData(view); setError('') } }, () => { if (active) setError('诊断暂不可用') }).finally(() => { reading = false })
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { active = false; cancelAnimationFrame(frame); stop() }
  }, [bridge, standalone, snapshot.epoch, snapshot.runtime?.developer.mode])
  if (snapshot.runtime?.developer.mode !== 'developer' || !bridge.readDiagnostics) return null
  return <div aria-label="安全诊断控制"><h2>开发诊断</h2>
    {!standalone && <button type="button" onClick={() => { void sendCommand(bridge, snapshot.epoch, { type: 'window.diagnostics.open' }).then((result) => { if (!result.ok) setError('独立诊断窗暂不可用') }, () => setError('独立诊断窗暂不可用')) }}>独立窗口</button>}
    <button type="button" onClick={() => { void bridge.readDiagnostics!().then(setData, () => setError('诊断暂不可用')) }}>刷新安全诊断</button>
    <p>模型可见投影已打码；邮件原文对照请使用候选卡的用户查阅入口。未知指标显示为未提供。</p>
    {error && <p role="alert">{error}</p>}
    {data && <div className="diagnostics-data">
      <details><summary>模型输入 · {data.contextSource === 'last-successful-input' ? '上次成功调用' : '尚未发送的投影'}</summary>
        {data.context.map((message, index) => <div key={index}><strong>{message.layer} · {message.role}</strong><pre>{message.text}</pre></div>)}{data.contextTruncated && <p>内容已截断。</p>}
      </details>
      <details><summary>回合记录 · {data.turns.length}</summary>{data.turns.map((turn) => <p key={turn.id}>{turn.id.slice(0, 8)} · {turn.status} · 输入 {turn.inputTokens ?? '未提供'} / 输出 {turn.outputTokens ?? '未提供'} token · 总耗时 {turn.durationMs ?? '未提供'} ms · 首字 {turn.firstTokenLatencyMs ?? '未提供'} · 缓存 {turn.cachedInputTokens ?? '未提供'} · 费用 {turn.cost ?? '未提供'}</p>)}</details>
      <details><summary>调度与 inbox · {data.queue.length} / {data.inbox.length}</summary><pre>{JSON.stringify({ queue: data.queue, inbox: data.inbox }, null, 2)}</pre></details>
      <details><summary>记忆检索打分 · {data.memoryScores.length}</summary><pre>{JSON.stringify(data.memoryScores, null, 2)}</pre></details>
      <p>邮箱：{data.privacy.mailStatus} · 文件滤芯：{data.privacy.fileFilteringEnabled ? '开' : '关'} · 待处理资料：{data.privacy.pendingFiles}</p>
    </div>}
  </div>
}

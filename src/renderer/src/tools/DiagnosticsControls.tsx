import { useEffect, useState } from 'react'
import type { AppBridge, AppSnapshot, DiagnosticsView } from '../../../shared'

export function DiagnosticsControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [data, setData] = useState<DiagnosticsView | null>(null); const [error, setError] = useState('')
  useEffect(() => { setData(null); setError('') }, [snapshot.epoch])
  if (snapshot.runtime?.developer.mode !== 'developer' || !bridge.readDiagnostics) return null
  return <div aria-label="安全诊断控制"><h2>开发诊断</h2>
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

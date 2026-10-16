import { useEffect, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { connectBridge } from '../app/connect-bridge'
import { activityText } from '../voice/activity-text'
import { DiagnosticsControls } from './DiagnosticsControls'
import './tools.css'

/** A read-only developer surface. Main denies this window's business commands and private user lookups. */
export function DiagnosticsWindow({ bridge }: { bridge: AppBridge }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  useEffect(() => connectBridge(bridge, setSnapshot, () => setSnapshot(null)), [bridge])
  if (!snapshot) return <div role="status">正在连接诊断…</div>
  if (snapshot.runtime?.developer.mode !== 'developer') return <p role="alert">当前模式不开放开发诊断。</p>
  return <main className="diagnostics-window">
    <h1>开发诊断 · 独立窗口</h1>
    <p>只读安全投影；跟随执行事件刷新，最多每秒一次。</p>
    <details open className="diagnostics-live"><summary>执行动态 · {snapshot.activities.length}</summary>
      <ol>{snapshot.activities.slice(-30).map((activity) => <li key={activity.id}>{activity.status} · {activityText(activity)}</li>)}</ol>
    </details>
    <DiagnosticsControls bridge={bridge} snapshot={snapshot} standalone />
  </main>
}

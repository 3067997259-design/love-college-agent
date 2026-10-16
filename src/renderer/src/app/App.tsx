import { useEffect, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { Stage } from '../book/Stage'
import { ScenarioSwitcher } from '../dev/ScenarioSwitcher'
import type { FakeBridge } from '../dev/fake-bridge'
import { connectBridge } from './connect-bridge'
import { ToolsPanel } from '../tools/ToolsPanel'

export function App({ bridge, fake }: { bridge: AppBridge; fake: FakeBridge | null }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => connectBridge(bridge, (next) => { setFailed(false); setSnapshot(next) }, () => setFailed(true)), [bridge])

  if (!snapshot) return <div className="boot" role="status"><h1 className="visually-hidden">Love, College &amp; Agent</h1>{failed ? '接口连接失败' : ''}</div>
  return (
    <>
      <Stage snapshot={snapshot} bridge={bridge} />
      {!fake && <ToolsPanel bridge={bridge} snapshot={snapshot} />}
      {fake && <ScenarioSwitcher fake={fake} />}
    </>
  )
}

import { useEffect, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { Stage } from '../book/Stage'
import { ScenarioSwitcher } from '../dev/ScenarioSwitcher'
import type { FakeBridge } from '../dev/fake-bridge'
import { connectBridge } from './connect-bridge'
import { ToolsPanel } from '../tools/ToolsPanel'
import { VoiceAudio } from '../voice/VoiceAudio'

export function App({ bridge, fake }: { bridge: AppBridge; fake: FakeBridge | null }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  useEffect(() => connectBridge(bridge, (next) => { setFailed(false); setSnapshot(next) }, () => setFailed(true)), [bridge])

  if (!snapshot) return <div className="boot" role="status"><h1 className="visually-hidden">Love, College &amp; Agent</h1>{failed ? '接口连接失败' : ''}</div>
  // 设置页要 runtime：真实接口都有，浏览器预览只有带 runtime 的场景才有，其余时候“设置”书签是灰的。浮动的工具面板只在开发模式
  const tools = !!snapshot.runtime
  return (
    <>
      {!fake && <VoiceAudio bridge={bridge} snapshot={snapshot} />}
      <Stage snapshot={snapshot} bridge={bridge} settings={tools} />
      {!fake && <ToolsPanel bridge={bridge} snapshot={snapshot} open={toolsOpen} onOpenChange={setToolsOpen} />}
      {fake && <ScenarioSwitcher fake={fake} />}
    </>
  )
}

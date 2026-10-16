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
  // 设置面板只在真实接口下有（runtime 存在时 ToolsPanel 才渲染）；浏览器预览里“设置”书签是灰的
  const tools = !fake && !!snapshot.runtime
  return (
    <>
      {!fake && <VoiceAudio bridge={bridge} snapshot={snapshot} />}
      <Stage snapshot={snapshot} bridge={bridge} onOpenTools={tools ? () => setToolsOpen(true) : undefined} />
      {!fake && <ToolsPanel bridge={bridge} snapshot={snapshot} open={toolsOpen} onOpenChange={setToolsOpen} />}
      {fake && <ScenarioSwitcher fake={fake} />}
    </>
  )
}

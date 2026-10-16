import { useEffect, useState } from 'react'
import type { FakeBridge } from './fake-bridge'
import { SCENARIOS, type ScenarioId } from './scenarios'
import './dev.css'

const IDS = Object.keys(SCENARIOS) as ScenarioId[]

/** 开发用：切换假快照场景。数字键 1–9 直接切。只在纯浏览器预览时出现。 */
export function ScenarioSwitcher({ fake }: { fake: FakeBridge }) {
  const [current, setCurrent] = useState(fake.scenarioId)
  const pick = (id: ScenarioId) => {
    fake.setScenario(id)
    setCurrent(id)
    const url = new URL(location.href)
    url.searchParams.set('scenario', id)
    history.replaceState(null, '', url)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      const id = IDS[Number(e.key) - 1]
      if (id) pick(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <aside className="dev-switcher" aria-label="假数据场景">
      <strong>假数据</strong>
      {IDS.map((id, i) => (
        <button key={id} data-active={id === current} onClick={() => pick(id)}>{i + 1} {id}</button>
      ))}
    </aside>
  )
}
